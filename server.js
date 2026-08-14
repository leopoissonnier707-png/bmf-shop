const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ADMIN_DISCORD_IDS = (process.env.ADMIN_DISCORD_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || 'undergroundsecret2024';
const REDIRECT_URL = process.env.REDIRECT_URL || `http://localhost:${PORT}/auth/callback`;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY; // hébergement gratuit des photos, pour ne pas remplir MongoDB
const ABSENCE_CHANNEL_ID = process.env.ABSENCE_CHANNEL_ID; // salon Discord où postent les absences
const LOGS_CHANNEL_ID = process.env.LOGS_CHANNEL_ID; // salon Discord où arrivent tous les logs d'actions

const { MongoClient } = require('mongodb');
const MONGO_URI = process.env.MONGO_URI;
let db = null;

async function getDB() {
  if (db) return db;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('undergroundshop');
  return db;
}

async function readJSON(collection, def) {
  try {
    const database = await getDB();
    const docs = await database.collection(collection).find({}).toArray();
    return docs.length ? docs : def;
  } catch (e) { console.error('DB read error:', e.message); return def; }
}

async function initDB() {
  try {
    const database = await getDB();
    const weapons = await database.collection('weapons').find({}).toArray();
    if (!weapons.length) {
      console.log('DB initialisée - catalogue vide, ajoutez vos armes depuis le panel admin');
    }
    console.log('MongoDB connecté avec succès !');
  } catch (e) {
    console.error('Erreur connexion MongoDB:', e.message);
  }
}

async function isAdminId(id) {
  if (ADMIN_DISCORD_IDS.includes(id)) return true;
  try {
    const database = await getDB();
    const admin = await database.collection('admins').findOne({ id });
    return !!admin;
  } catch(e) { return false; }
}

async function isUserBanned(userId) {
  if (!BOT_TOKEN || !DISCORD_GUILD_ID) return false;
  try {
    await axios.get(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/bans/${userId}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    return true; // 200 = banni
  } catch (e) {
    return false; // 404 = pas banni
  }
}

// =====================
// SYSTÈME DE LOGS — envoie chaque action importante dans un salon Discord dédié
// =====================
async function sendLog(action, description, user, color = 0xcda349) {
  if (!BOT_TOKEN || !LOGS_CHANNEL_ID) return;
  try {
    const who = user ? `<@${user.id}> (${user.username})` : 'Système';
    await axios.post(
      `https://discord.com/api/v10/channels/${LOGS_CHANNEL_ID}/messages`,
      {
        embeds: [{
          title: `📝 ${action}`,
          description,
          color,
          fields: [{ name: 'Par', value: who, inline: true }],
          timestamp: new Date().toISOString()
        }]
      },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Erreur envoi log:', err.response?.data || err.message);
  }
}

app.use(express.json({ limit: '5mb' }));

// =====================
// SÉCURITÉ — en-têtes HTTP standards
// =====================
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// =====================
// SÉCURITÉ — limitation de débit basique (anti-spam / anti-bruteforce, en mémoire)
// =====================
const rateLimitBuckets = new Map();
function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const key = req.ip + ':' + req.path;
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key) || [];
    const recent = bucket.filter(t => now - t < windowMs);
    if (recent.length >= maxRequests) {
      return res.status(429).json({ error: 'Trop de requêtes, réessaie dans quelques instants.' });
    }
    recent.push(now);
    rateLimitBuckets.set(key, recent);
    next();
  };
}
// Nettoyage périodique pour éviter que la mémoire grossisse indéfiniment
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [key, arr] of rateLimitBuckets) {
    const kept = arr.filter(t => t > cutoff);
    if (kept.length) rateLimitBuckets.set(key, kept); else rateLimitBuckets.delete(key);
  }
}, 5 * 60 * 1000);

// =====================
// SÉCURITÉ — vérifie que les requêtes qui modifient des données viennent bien du site lui-même
// =====================
function checkOrigin(req, res, next) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return next(); // apps mobiles/outils tiers sans header origin : on laisse passer
  try {
    const originHost = new URL(origin).host;
    if (originHost !== req.headers.host) {
      return res.status(403).json({ error: 'Origine non autorisée' });
    }
  } catch (e) {}
  next();
}
app.use((req, res, next) => {
  if (['POST','PUT','DELETE','PATCH'].includes(req.method)) return checkOrigin(req, res, next);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URI, dbName: 'undergroundshop' }),
  cookie: { secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

app.get('/auth/discord', rateLimit(10, 60000), (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URL,
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/');
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URL,
        scope: 'identify'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data.access_token;
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const user = userRes.data;

    if (await isUserBanned(user.id)) {
      return res.redirect('/?banned=1');
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar,
      globalName: user.global_name || user.username
    };
    req.session.isAdmin = await isAdminId(user.id);
    res.redirect('/');
  } catch (err) {
    console.error('Erreur OAuth2:', err.message);
    res.redirect('/');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// =====================
// API — UTILISATEUR (vérifie le bannissement à CHAQUE chargement de page)
// =====================
app.get('/api/me', async (req, res) => {
  if (req.session.user) {
    if (await isUserBanned(req.session.user.id)) {
      req.session.destroy();
      return res.json({ user: null, isAdmin: false, banned: true });
    }
    req.session.isAdmin = await isAdminId(req.session.user.id);
    res.json({ user: req.session.user, isAdmin: req.session.isAdmin });
  } else {
    res.json({ user: null, isAdmin: false });
  }
});

// =====================
// API — UPLOAD PHOTOS (hébergées gratuitement sur imgbb, pas dans MongoDB)
// =====================
app.post('/api/upload-image', requirePermission('manageWeapons'), async (req, res) => {
  if (!IMGBB_API_KEY) return res.status(400).json({ error: 'IMGBB_API_KEY manquante sur le serveur' });
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'Image manquante' });
  try {
    const base64Data = image.split(',')[1] || image; // retire le préfixe data:image/...;base64,
    const params = new URLSearchParams();
    params.append('key', IMGBB_API_KEY);
    params.append('image', base64Data);
    const uploadRes = await axios.post('https://api.imgbb.com/1/upload', params);
    res.json({ success: true, url: uploadRes.data.data.url });
  } catch (err) {
    console.error('Erreur upload imgbb:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erreur upload photo' });
  }
});

// =====================
// API — PARAMÈTRES PERSONNELS (couleur, taille du texte — sauvegardés par compte)
// =====================
app.get('/api/my-settings', async (req, res) => {
  const defaults = { accentColor: null, fontSize: 'normal', corners: 'rounded', glass: 'normal', motion: 'normal', density: 'comfortable', bgAnim: 'on', cardSize: 'medium', sort: 'default', glow: 'normal' };
  if (!req.session.user) return res.json(defaults);
  const database = await getDB();
  const s = await database.collection('userSettings').findOne({ discordId: req.session.user.id });
  res.json({ ...defaults, ...(s || {}) });
});

app.post('/api/my-settings', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const { accentColor, fontSize, corners, glass, motion, density, bgAnim, cardSize, sort, glow } = req.body;
  const database = await getDB();
  await database.collection('userSettings').updateOne(
    { discordId: req.session.user.id },
    { $set: { discordId: req.session.user.id, accentColor: accentColor || null, fontSize: fontSize || 'normal',
        corners: corners || 'rounded', glass: glass || 'normal', motion: motion || 'normal',
        density: density || 'comfortable', bgAnim: bgAnim || 'on', cardSize: cardSize || 'medium',
        sort: sort || 'default', glow: glow || 'normal' } },
    { upsert: true }
  );
  res.json({ success: true });
});

app.get('/api/categories', async (req, res) => {
  const database = await getDB();
  let cats = await database.collection('categories').find({}).toArray();
  if (!cats.length) {
    const defaults = ['Pistolet','Fusil','Sniper','Explosif','Couteau','Drogue','Autre'];
    await database.collection('categories').insertMany(defaults.map(name => ({ name })));
    cats = defaults.map(name => ({ name }));
  }
  res.json(cats.map(c => c.name));
});

app.post('/api/categories', requirePermission('manageWeapons'), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom manquant' });
  const database = await getDB();
  const exists = await database.collection('categories').findOne({ name: name.trim() });
  if (exists) return res.status(400).json({ error: 'Catégorie déjà existante' });
  await database.collection('categories').insertOne({ name: name.trim() });
  sendLog('Catégorie créée', `**${name.trim()}**`, req.session.user, 0x7fae70);
  res.json({ success: true });
});

app.delete('/api/categories/:name', requirePermission('deleteItems'), async (req, res) => {
  const database = await getDB();
  await database.collection('categories').deleteOne({ name: req.params.name });
  sendLog('Catégorie supprimée', `**${req.params.name}**`, req.session.user, 0xb3394c);
  res.json({ success: true });
});

app.get('/api/weapons', async (req, res) => {
  res.json(await readJSON('weapons', []));
});

app.post('/api/weapons', requirePermission('manageWeapons'), async (req, res) => {
  const { name, cat, price, desc, photos, currency } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Champs manquants' });
  const weapon = { id: Date.now(), name, cat: cat || 'Autre', price: parseInt(price), desc: desc || '', photos: photos || [], currency: currency || 'sale' };
  try {
    const database = await getDB();
    await database.collection('weapons').insertOne(weapon);
    sendLog('Article ajouté au catalogue', `**${weapon.name}** (${weapon.cat}) — ${weapon.price.toLocaleString('fr-FR')}€`, req.session.user, 0x7fae70);
    res.json({ success: true, weapon });
  } catch(e) { res.status(500).json({ error: 'Erreur DB' }); }
});

app.put('/api/weapons/:id', requirePermission('manageWeapons'), async (req, res) => {
  try {
    const database = await getDB();
    const { _id, ...update } = req.body;
    await database.collection('weapons').updateOne({ id: parseInt(req.params.id) }, { $set: update });
    sendLog('Article modifié', `**${update.name || req.params.id}** a été modifié dans le catalogue`, req.session.user, 0xcda349);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Erreur DB' }); }
});

app.delete('/api/weapons/:id', requirePermission('deleteItems'), async (req, res) => {
  try {
    const database = await getDB();
    const weapon = await database.collection('weapons').findOne({ id: parseInt(req.params.id) });
    await database.collection('weapons').deleteOne({ id: parseInt(req.params.id) });
    sendLog('Article supprimé du catalogue', `**${weapon?.name || req.params.id}** a été supprimé`, req.session.user, 0xb3394c);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Erreur DB' }); }
});

app.get('/api/promos', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const database = await getDB();
  res.json(await database.collection('promos').find({}).toArray());
});

app.post('/api/promos', requirePermission('managePromos'), async (req, res) => {
  const { code, discount } = req.body;
  if (!code || !discount) return res.status(400).json({ error: 'Champs manquants' });
  const database = await getDB();
  const exists = await database.collection('promos').findOne({ code: code.toUpperCase() });
  if (exists) return res.status(400).json({ error: 'Code déjà existant' });
  const promo = { code: code.toUpperCase(), discount: parseInt(discount), active: true, usages: 0, createdAt: new Date().toISOString() };
  await database.collection('promos').insertOne(promo);
  sendLog('Code promo créé', `**${promo.code}** — ${promo.discount}%`, req.session.user, 0x7fae70);
  res.json({ success: true, promo });
});

app.delete('/api/promos/:code', requirePermission('managePromos'), async (req, res) => {
  const database = await getDB();
  await database.collection('promos').deleteOne({ code: req.params.code });
  sendLog('Code promo supprimé', `**${req.params.code}**`, req.session.user, 0xb3394c);
  res.json({ success: true });
});

app.post('/api/promos/check', async (req, res) => {
  const { code } = req.body;
  const database = await getDB();
  const promo = await database.collection('promos').findOne({ code: code?.toUpperCase(), active: true });
  if (!promo) return res.status(404).json({ error: 'Code invalide ou inactif' });
  res.json({ discount: promo.discount, code: promo.code });
});

// =====================
// API — COMMANDES (suppression douce : les commandes supprimées restent
// consultables via la recherche par ID, mais disparaissent de la liste normale)
// =====================
app.get('/api/orders', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const database = await getDB();
  const orders = await database.collection('orders').find({ deleted: { $ne: true } }).sort({ createdAt: -1 }).toArray();
  res.json(orders);
});

app.post('/api/order', rateLimit(8, 60000), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });

  const { pseudo, gang, phone, signature, items, total, promoCode, discount } = req.body;
  const user = req.session.user;

  if (!pseudo || !gang || !phone || !signature || !items || total === undefined) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  if (promoCode) {
    try {
      const database = await getDB();
      await database.collection('promos').updateOne({ code: promoCode }, { $inc: { usages: 1 } });
    } catch(e) {}
  }

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  const itemsList = items.map(i => `• **${i.name}** x${i.qty} — ${i.sub.toLocaleString('fr-FR')}€`).join('\n');
  const promoLine = promoCode ? `\n🏷️ Code promo: **${promoCode}** (-${discount}%)` : '';

  const order = {
    id: Date.now(),
    pseudo, gang, phone,
    discordId: user.id,
    discordUser: user,
    items, total,
    promoCode: promoCode || null,
    discount: discount || 0,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  try {
    const database = await getDB();
    await database.collection('orders').insertOne(order);
  } catch(e) { console.error('Erreur sauvegarde commande:', e.message); }

  const embed = {
    embeds: [{
      title: '🔫 Nouvelle commande Underground',
      color: 0x00d4c8,
      thumbnail: { url: avatarUrl },
      fields: [
        { name: '🎮 Compte Discord', value: `<@${user.id}> (${user.username})`, inline: true },
        { name: '👤 Pseudo illégal', value: pseudo, inline: true },
        { name: '🏴 Groupe illégal', value: gang, inline: true },
        { name: '📞 Téléphone RP', value: phone, inline: true },
        { name: '✍️ Signature', value: 'Signée ✅', inline: true },
        { name: '📦 Articles commandés', value: itemsList + promoLine },
        { name: '💰 Total argent sale', value: `**${total.toLocaleString('fr-FR')}€**`, inline: true },
        { name: '🆔 Discord ID', value: user.id, inline: true },
        { name: '🔖 ID Commande', value: `#${order.id}`, inline: true }
      ],
      footer: { text: `Underground Shop · Commande #${order.id} · EN ATTENTE` },
      timestamp: new Date().toISOString()
    }],
    content: `📦 **Nouvelle commande** de ${user.username} | ID: \`${order.id}\``
  };

  try {
    if (DISCORD_WEBHOOK_URL) await axios.post(DISCORD_WEBHOOK_URL + '?wait=true', embed);
  } catch (err) {
    console.error('Erreur webhook:', err.response?.data || err.message);
  }

  sendLog('Nouvel achat', `${itemsList} — Total: **${total.toLocaleString('fr-FR')}€**`, user, 0xcda349);
  res.json({ success: true, orderId: order.id });
});

app.post('/api/order/done', requirePermission('manageOrders'), async (req, res) => {
  const { orderId, discordId, pseudo } = req.body;
  const processedBy = req.session.user ? req.session.user.username : 'Underground';

  try {
    const database = await getDB();
    await database.collection('orders').updateOne({ id: parseInt(orderId) }, { $set: { status: 'done', doneAt: new Date().toISOString(), processedBy } });
  } catch(e) { console.error('Erreur update order:', e.message); }

  if (BOT_TOKEN && discordId) {
    try {
      const dmRes = await axios.post(`https://discord.com/api/v10/users/@me/channels`,
        { recipient_id: discordId },
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      const channelId = dmRes.data.id;
      await axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`,
        {
          embeds: [{
            title: '✅ Votre commande Underground est prête !',
            color: 0x4ade80,
            description: `Bonjour **${pseudo}** ! 🎮\n\nVotre commande sur **Underground Shop** est prête.\nTraité par un membre des **Underground** : **${processedBy}**.\nVous serez contacté **en jeu** très prochainement par un membre des **Underground** pour la livraison.\n\nMerci de votre confiance ! 🔫`,
            footer: { text: 'Underground Black Market · RP FiveM' },
            timestamp: new Date().toISOString()
          }]
        },
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      console.error('Erreur MP Discord:', err.response?.data || err.message);
    }
  }

  sendLog('Commande validée', `Commande **#${orderId}** de **${pseudo}** marquée comme prête`, req.session.user, 0x7fae70);
  res.json({ success: true });
});

// Suppression DOUCE : la commande n'est plus effacée, juste marquée "deleted".
// Elle reste donc trouvable via la recherche par ID Discord.
app.delete('/api/order/:id', requirePermission('manageOrders'), async (req, res) => {
  const database = await getDB();
  await database.collection('orders').updateOne(
    { id: parseInt(req.params.id) },
    { $set: { deleted: true, deletedAt: new Date().toISOString() } }
  );
  sendLog('Commande supprimée', `Commande **#${req.params.id}** supprimée (reste consultable via la recherche)`, req.session.user, 0xb3394c);
  res.json({ success: true });
});

app.get('/api/admins', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const database = await getDB();
  res.json(await database.collection('admins').find({}).toArray());
});

app.post('/api/admins', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const { id, note } = req.body;
  if (!id) return res.status(400).json({ error: 'ID manquant' });
  const database = await getDB();
  const exists = await database.collection('admins').findOne({ id });
  if (exists) return res.status(400).json({ error: 'Admin déjà existant' });
  await database.collection('admins').insertOne({ id, note: note || '', addedAt: new Date().toISOString() });
  sendLog('Nouvel admin ajouté', `ID Discord : **${id}**${note ? ` — ${note}` : ''}`, req.session.user, 0x7fae70);
  res.json({ success: true });
});

app.delete('/api/admins/:id', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const database = await getDB();
  await database.collection('admins').deleteOne({ id: req.params.id });
  sendLog('Admin retiré', `ID Discord : **${req.params.id}**`, req.session.user, 0xb3394c);
  res.json({ success: true });
});

app.get('/api/roles', async (req, res) => {
  if (!BOT_TOKEN || !DISCORD_GUILD_ID) {
    return res.status(400).json({ error: 'BOT_TOKEN ou DISCORD_GUILD_ID manquant dans les variables d\'environnement' });
  }
  try {
    const rolesRes = await axios.get(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/roles`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    const PERMISSION_FLAGS = {
      ADMINISTRATOR: 0x8n,
      MANAGE_GUILD: 0x20n,
      MANAGE_ROLES: 0x10000000n,
      MANAGE_CHANNELS: 0x10n,
      KICK_MEMBERS: 0x2n,
      BAN_MEMBERS: 0x4n,
      MANAGE_MESSAGES: 0x2000n,
      MENTION_EVERYONE: 0x20000n,
      MANAGE_NICKNAMES: 0x8000000n,
      MANAGE_WEBHOOKS: 0x20000000n,
      MODERATE_MEMBERS: 0x10000000000n
    };
    const roles = rolesRes.data
      .filter(r => r.name !== '@everyone')
      .sort((a, b) => b.position - a.position)
      .map(r => {
        const permBits = BigInt(r.permissions);
        const perms = Object.entries(PERMISSION_FLAGS)
          .filter(([, flag]) => (permBits & flag) === flag)
          .map(([name]) => name);
        return {
          id: r.id,
          name: r.name,
          color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : '#99aab5',
          position: r.position,
          managed: r.managed,
          permissions: perms
        };
      });
    res.json(roles);
  } catch (err) {
    console.error('Erreur récupération rôles Discord:', err.response?.data || err.message);
    res.status(500).json({ error: 'Impossible de récupérer les rôles Discord' });
  }
});

app.get('/api/stats', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const database = await getDB();
  const orders = await database.collection('orders').find({ deleted: { $ne: true } }).toArray();
  const pending = orders.filter(o => o.status === 'pending').length;
  const done = orders.filter(o => o.status === 'done').length;
  const totalRevenue = orders.filter(o => o.status === 'done').reduce((a, o) => a + o.total, 0);
  const weaponCount = await database.collection('weapons').countDocuments();
  const adminCount = await database.collection('admins').countDocuments();
  res.json({ pending, done, total: orders.length, totalRevenue, weaponCount, adminCount: adminCount + 1 });
});

const PERMISSION_KEYS = ['accessAdmin', 'manageWeapons', 'manageOrders', 'managePromos', 'deleteItems', 'accessAbsence'];

async function getUserPermissions(userId) {
  const fullAdmin = await isAdminId(userId);
  if (fullAdmin) {
    const all = {}; PERMISSION_KEYS.forEach(k => all[k] = true);
    return { isFullAdmin: true, ...all };
  }
  const result = { isFullAdmin: false };
  PERMISSION_KEYS.forEach(k => result[k] = false);
  if (!BOT_TOKEN || !DISCORD_GUILD_ID) return result;
  try {
    const memberRes = await axios.get(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${userId}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    const roleIds = memberRes.data.roles || [];
    if (!roleIds.length) return result;
    const database = await getDB();
    const perms = await database.collection('rolePermissions').find({ roleId: { $in: roleIds } }).toArray();
    perms.forEach(p => { PERMISSION_KEYS.forEach(k => { if (p[k]) result[k] = true; }); });
    return result;
  } catch (e) { return result; }
}

function requirePermission(key) {
  return async (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
    const perms = await getUserPermissions(req.session.user.id);
    if (!perms[key]) return res.status(403).json({ error: 'Permission refusée' });
    next();
  };
}

app.get('/api/my-permissions', async (req, res) => {
  if (!req.session.user) return res.json({ isFullAdmin: false });
  res.json(await getUserPermissions(req.session.user.id));
});

app.get('/api/role-permissions', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const database = await getDB();
  res.json(await database.collection('rolePermissions').find({}).toArray());
});

app.post('/api/role-permissions', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const { roleId, roleName, accessAdmin, manageWeapons, manageOrders, managePromos, deleteItems, accessAbsence } = req.body;
  if (!roleId) return res.status(400).json({ error: 'roleId manquant' });
  const database = await getDB();
  await database.collection('rolePermissions').updateOne(
    { roleId },
    { $set: { roleId, roleName, accessAdmin: !!accessAdmin, manageWeapons: !!manageWeapons, manageOrders: !!manageOrders, managePromos: !!managePromos, deleteItems: !!deleteItems, accessAbsence: !!accessAbsence } },
    { upsert: true }
  );
  sendLog('Permissions de rôle modifiées', `Rôle **${roleName || roleId}** mis à jour`, req.session.user, 0xcda349);
  res.json({ success: true });
});

app.get('/api/roles/:roleId/members', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  if (!BOT_TOKEN || !DISCORD_GUILD_ID) return res.status(400).json({ error: 'Config manquante' });
  try {
    let all = []; let after = '0';
    while (true) {
      const r = await axios.get(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members?limit=1000&after=${after}`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` }
      });
      if (!r.data.length) break;
      all = all.concat(r.data);
      after = r.data[r.data.length - 1].user.id;
      if (r.data.length < 1000) break;
    }
    const filtered = all.filter(m => m.roles.includes(req.params.roleId)).map(m => ({
      id: m.user.id, username: m.user.username, nick: m.nick || null
    }));
    res.json(filtered);
  } catch (e) {
    console.error('Erreur membres rôle:', e.response?.data || e.message);
    res.status(500).json({ error: 'Erreur récupération membres' });
  }
});

// Recherche par ID Discord : montre TOUT, y compris les commandes supprimées
// (marquées "deleted") pour garder un historique complet consultable.
app.get('/api/orders/search/:discordId', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const database = await getDB();
  const orders = await database.collection('orders').find({ discordId: req.params.discordId }).sort({ createdAt: -1 }).toArray();
  res.json(orders);
});

// =====================
// API — SYSTÈME D'ABSENCE
// =====================
// Chaque personne a UN SEUL message dans le salon d'absence. Si elle poste une nouvelle
// absence, ce message existant est mis à jour (édité) au lieu d'en créer un nouveau.
async function rebuildAbsenceMessage(discordId) {
  const database = await getDB();
  const user = (await database.collection('absences').findOne({ discordId }))?.discordUser;
  const allEntries = await database.collection('absences').find({ discordId }).sort({ createdAt: -1 }).toArray();
  const existing = await database.collection('absenceMessages').findOne({ discordId });

  if (!allEntries.length) {
    // Plus aucune absence : on supprime le post Discord s'il existe
    if (existing && existing.messageId && BOT_TOKEN && ABSENCE_CHANNEL_ID) {
      try {
        await axios.delete(`https://discord.com/api/v10/channels/${ABSENCE_CHANNEL_ID}/messages/${existing.messageId}`,
          { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
      } catch(e) {}
    }
    if (existing) await database.collection('absenceMessages').deleteOne({ discordId });
    return;
  }
  if (!BOT_TOKEN || !ABSENCE_CHANNEL_ID || !user) return;

  // Nom affiché sur le serveur Discord (pseudo serveur), pas le nom de compte global
  let displayName = user.username;
  try {
    const memberRes = await axios.get(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${discordId}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    displayName = memberRes.data.nick || memberRes.data.user?.global_name || user.username;
  } catch(e) {}

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  const listText = allEntries.map(e =>
    `📌 **${e.rpName}**\n🕒 Du **${new Date(e.from).toLocaleString('fr-FR')}** au **${new Date(e.to).toLocaleString('fr-FR')}**\nRenseigné le ${new Date(e.createdAt).toLocaleDateString('fr-FR')}`
  ).join('\n\n');

  const embed = {
    embeds: [{
      title: `📋 Absences — ${displayName}`,
      color: 0xfbbf24,
      thumbnail: { url: avatarUrl },
      description: listText,
      footer: { text: `Discord ID: ${discordId}` },
      timestamp: new Date().toISOString()
    }],
    content: `<@${discordId}> a mis à jour ses absences.`
  };

  if (existing && existing.messageId) {
    try {
      await axios.patch(`https://discord.com/api/v10/channels/${ABSENCE_CHANNEL_ID}/messages/${existing.messageId}`, embed,
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } });
      return;
    } catch(e) { /* message supprimé côté Discord, on en recrée un */ }
  }
  const msgRes = await axios.post(`https://discord.com/api/v10/channels/${ABSENCE_CHANNEL_ID}/messages`, embed,
    { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } });
  await database.collection('absenceMessages').updateOne({ discordId }, { $set: { messageId: msgRes.data.id } }, { upsert: true });
}

app.post('/api/absence', rateLimit(10, 60000), requirePermission('accessAbsence'), async (req, res) => {
  const { rpName, from, to } = req.body;
  const user = req.session.user;
  if (!rpName || !from || !to) return res.status(400).json({ error: 'Champs manquants' });
  if (!BOT_TOKEN || !ABSENCE_CHANNEL_ID) return res.status(400).json({ error: 'BOT_TOKEN ou ABSENCE_CHANNEL_ID manquant' });

  const database = await getDB();
  try {
    const result = await database.collection('absences').insertOne({
      discordId: user.id, discordUser: user, rpName, from, to, createdAt: new Date().toISOString()
    });
    await rebuildAbsenceMessage(user.id);
    sendLog('Absence déclarée', `**${rpName}** — du ${new Date(from).toLocaleString('fr-FR')} au ${new Date(to).toLocaleString('fr-FR')}`, user, 0xcda349);
    res.json({ success: true, id: result.insertedId });
  } catch (err) {
    console.error('Erreur absence:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erreur lors de l\'envoi de l\'absence' });
  }
});

// Modifier une absence existante (uniquement la sienne, sauf pour un admin complet)
app.put('/api/absence/:id', requirePermission('accessAbsence'), async (req, res) => {
  const { ObjectId } = require('mongodb');
  let objId;
  try { objId = new ObjectId(req.params.id); } catch(e) { return res.status(400).json({ error: 'ID invalide' }); }
  const database = await getDB();
  const entry = await database.collection('absences').findOne({ _id: objId });
  if (!entry) return res.status(404).json({ error: 'Absence introuvable' });
  if (entry.discordId !== req.session.user.id && !req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const { rpName, from, to } = req.body;
  await database.collection('absences').updateOne(
    { _id: objId },
    { $set: { rpName: rpName || entry.rpName, from: from || entry.from, to: to || entry.to } }
  );
  await rebuildAbsenceMessage(entry.discordId);
  sendLog('Absence modifiée', `Absence de **${rpName || entry.rpName}** modifiée`, req.session.user, 0xcda349);
  res.json({ success: true });
});

// Annuler / supprimer une absence (uniquement la sienne, sauf pour un admin complet)
app.delete('/api/absence/:id', requirePermission('accessAbsence'), async (req, res) => {
  const { ObjectId } = require('mongodb');
  let objId;
  try { objId = new ObjectId(req.params.id); } catch(e) { return res.status(400).json({ error: 'ID invalide' }); }
  const database = await getDB();
  const entry = await database.collection('absences').findOne({ _id: objId });
  if (!entry) return res.status(404).json({ error: 'Absence introuvable' });
  if (entry.discordId !== req.session.user.id && !req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  await database.collection('absences').deleteOne({ _id: objId });
  await rebuildAbsenceMessage(entry.discordId);
  sendLog('Absence annulée', `Absence de **${entry.rpName}** annulée`, req.session.user, 0xb3394c);
  res.json({ success: true });
});

app.get('/api/absence/mine', requirePermission('accessAbsence'), async (req, res) => {
  const database = await getDB();
  const mine = await database.collection('absences').find({ discordId: req.session.user.id }).sort({ createdAt: -1 }).toArray();
  res.json(mine);
});

// Toutes les absences de tout le monde, pour affichage sur le calendrier
app.get('/api/absence/all', requirePermission('accessAbsence'), async (req, res) => {
  const database = await getDB();
  const all = await database.collection('absences').find({}).sort({ from: 1 }).toArray();
  res.json(all);
});

// =====================
// API — IMAGES DE FOND (gérées par lien, depuis le panel admin)
// =====================
app.get('/api/backgrounds', async (req, res) => {
  try {
    const database = await getDB();
    const list = await database.collection('backgrounds').find({}).toArray();
    res.json(list.map(b => ({ id: b._id, url: b.url })));
  } catch (e) { res.json([]); }
});

app.post('/api/backgrounds', requirePermission('manageWeapons'), async (req, res) => {
  const { url } = req.body;
  if (!url || !url.trim()) return res.status(400).json({ error: 'Lien manquant' });
  const database = await getDB();
  const result = await database.collection('backgrounds').insertOne({ url: url.trim(), addedAt: new Date().toISOString() });
  sendLog('Photo de fond ajoutée', url.trim(), req.session.user, 0x7fae70);
  res.json({ success: true, id: result.insertedId });
});

app.delete('/api/backgrounds/:id', requirePermission('deleteItems'), async (req, res) => {
  const { ObjectId } = require('mongodb');
  let objId;
  try { objId = new ObjectId(req.params.id); } catch(e) { return res.status(400).json({ error: 'ID invalide' }); }
  const database = await getDB();
  await database.collection('backgrounds').deleteOne({ _id: objId });
  sendLog('Photo de fond supprimée', `ID: ${req.params.id}`, req.session.user, 0xb3394c);
  res.json({ success: true });
});

app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

app.get('*', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Underground Shop démarré sur le port ${PORT}`);
  });
}).catch(err => {
  console.error('Erreur au démarrage :', err);
});
