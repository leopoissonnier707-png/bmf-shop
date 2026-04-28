

const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// CRITIQUE pour Render/Heroku : sans ça, les cookies de session ne fonctionnent pas derrière un proxy HTTPS
app.set('trust proxy', 1);

// =====================
// CONFIG
// =====================
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ADMIN_DISCORD_ID = process.env.ADMIN_DISCORD_ID;
const SESSION_SECRET = process.env.SESSION_SECRET || 'bmfsecret2024';
const REDIRECT_URL = process.env.REDIRECT_URL || `http://localhost:${PORT}/auth/callback`;
const BOT_TOKEN = process.env.BOT_TOKEN;

// =====================
// PERSISTANCE MONGODB ATLAS (persistante à vie)
// =====================
const { MongoClient } = require('mongodb');
const MONGO_URI = process.env.MONGO_URI;
let db = null;

async function getDB() {
  if (db) return db;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('bmfshop');
  return db;
}

async function readJSON(collection, def) {
  try {
    const database = await getDB();
    const docs = await database.collection(collection).find({}).toArray();
    return docs.length ? docs : def;
  } catch (e) { console.error('DB read error:', e.message); return def; }
}

async function writeJSON(collection, data) {
  try {
    const database = await getDB();
    await database.collection(collection).deleteMany({});
    if (Array.isArray(data) && data.length > 0) {
      await database.collection(collection).insertMany(data);
    }
  } catch (e) { console.error('DB write error:', e.message); }
}

async function initDB() {
  try {
    const database = await getDB();
    const weapons = await database.collection('weapons').find({}).toArray();
    if (!weapons.length) {
      console.log('DB initialisée - catalogue vide, ajoutez vos armes depuis le panel admin');
    }
    const promos = await database.collection('promos').find({}).toArray();
    if (!promos.length) {
      await database.collection('promos').insertMany([
        { code:'BMFVIP', discount:10, active:true, usages:0, createdAt: new Date().toISOString() }
      ]);
    }
    console.log('MongoDB connecté avec succès !');
  } catch (e) {
    console.error('Erreur connexion MongoDB:', e.message);
  }
}

// =====================
// ADMIN CHECK
// =====================
async function isAdminId(id) {
  if (id === ADMIN_DISCORD_ID) return true;
  try {
    const database = await getDB();
    const admin = await database.collection('admins').findOne({ id });
    return !!admin;
  } catch(e) { return false; }
}

// =====================
// MIDDLEWARE
// =====================
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URI, dbName: 'bmfshop' }),
  cookie: { secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// =====================
// AUTH DISCORD OAUTH2
// =====================
app.get('/auth/discord', (req, res) => {
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
// API — UTILISATEUR
// =====================
app.get('/api/me', async (req, res) => {
  if (req.session.user) {
    req.session.isAdmin = await isAdminId(req.session.user.id);
    res.json({ user: req.session.user, isAdmin: req.session.isAdmin });
  } else {
    res.json({ user: null, isAdmin: false });
  }
});

// =====================
// API — ARMES (lecture publique, écriture admin)
// =====================
app.get('/api/weapons', async (req, res) => {
  res.json(await readJSON('weapons', []));
});

app.post('/api/weapons', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const { name, cat, price, desc, photos, currency } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Champs manquants' });
  const weapon = { id: Date.now(), name, cat: cat || 'Autre', price: parseInt(price), desc: desc || '', photos: photos || [], currency: currency || 'sale' };
  try {
    const database = await getDB();
    await database.collection('weapons').insertOne(weapon);
    res.json({ success: true, weapon });
  } catch(e) { res.status(500).json({ error: 'Erreur DB' }); }
});

app.put('/api/weapons/:id', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  try {
    const database = await getDB();
    const { _id, ...update } = req.body;
    await database.collection('weapons').updateOne({ id: parseInt(req.params.id) }, { $set: update });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Erreur DB' }); }
});

app.delete('/api/weapons/:id', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  try {
    const database = await getDB();
    await database.collection('weapons').deleteOne({ id: parseInt(req.params.id) });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Erreur DB' }); }
});

// =====================
// API — CODES PROMO
// =====================
app.get('/api/promos', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const database = await getDB();
  res.json(await database.collection('promos').find({}).toArray());
});

app.post('/api/promos', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const { code, discount } = req.body;
  if (!code || !discount) return res.status(400).json({ error: 'Champs manquants' });
  const database = await getDB();
  const exists = await database.collection('promos').findOne({ code: code.toUpperCase() });
  if (exists) return res.status(400).json({ error: 'Code déjà existant' });
  const promo = { code: code.toUpperCase(), discount: parseInt(discount), active: true, usages: 0, createdAt: new Date().toISOString() };
  await database.collection('promos').insertOne(promo);
  res.json({ success: true, promo });
});

app.delete('/api/promos/:code', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const database = await getDB();
  await database.collection('promos').deleteOne({ code: req.params.code });
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
// API — COMMANDES
// =====================
app.get('/api/orders', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const database = await getDB();
  const orders = await database.collection('orders').find({}).sort({ createdAt: -1 }).toArray();
  res.json(orders);
});

app.post('/api/order', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });

  const { pseudo, gang, phone, signature, items, total, promoCode, discount } = req.body;
  const user = req.session.user;

  if (!pseudo || !gang || !phone || !signature || !items || total === undefined) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  // Incrémenter usage promo
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

  // Sauvegarder la commande côté serveur (MongoDB)
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

  // Envoyer sur Discord Webhook
  const embed = {
    embeds: [{
      title: '🔫 Nouvelle commande BMF',
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
      footer: { text: `BMF Shop · Commande #${order.id} · EN ATTENTE` },
      timestamp: new Date().toISOString()
    }],
    content: `📦 **Nouvelle commande** de ${user.username} | ID: \`${order.id}\``
  };

  try {
    if (DISCORD_WEBHOOK_URL) await axios.post(DISCORD_WEBHOOK_URL + '?wait=true', embed);
  } catch (err) {
    console.error('Erreur webhook:', err.response?.data || err.message);
  }

  res.json({ success: true, orderId: order.id });
});

app.post('/api/order/done', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });

  const { orderId, discordId, pseudo } = req.body;

  // Mettre à jour le statut de la commande (MongoDB)
  try {
    const database = await getDB();
    await database.collection('orders').updateOne({ id: parseInt(orderId) }, { $set: { status: 'done', doneAt: new Date().toISOString() } });
  } catch(e) { console.error('Erreur update order:', e.message); }

  // Envoyer MP Discord si BOT_TOKEN configuré
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
            title: '✅ Votre commande BMF est prête !',
            color: 0x4ade80,
            description: `Bonjour **${pseudo}** ! 🎮\n\nVotre commande sur **BMF Shop** est prête.\nVous serez contacté **en jeu** très prochainement par un membre du staff BMF.\n\nMerci de votre confiance ! 🔫`,
            footer: { text: 'BMF Black Market · RP FiveM' },
            timestamp: new Date().toISOString()
          }]
        },
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      console.error('Erreur MP Discord:', err.response?.data || err.message);
    }
  }

  res.json({ success: true });
});

app.delete('/api/order/:id', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const database = await getDB();
  await database.collection('orders').deleteOne({ id: parseInt(req.params.id) });
  res.json({ success: true });
});

// =====================
// API — ADMINS
// =====================
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
  res.json({ success: true });
});

app.delete('/api/admins/:id', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const database = await getDB();
  await database.collection('admins').deleteOne({ id: req.params.id });
  res.json({ success: true });
});

// =====================
// API — STATS
// =====================
app.get('/api/stats', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const database = await getDB();
  const orders = await database.collection('orders').find({}).toArray();
  const pending = orders.filter(o => o.status === 'pending').length;
  const done = orders.filter(o => o.status === 'done').length;
  const totalRevenue = orders.filter(o => o.status === 'done').reduce((a, o) => a + o.total, 0);
  const weaponCount = await database.collection('weapons').countDocuments();
  const adminCount = await database.collection('admins').countDocuments();
  res.json({ pending, done, total: orders.length, totalRevenue, weaponCount, adminCount: adminCount + 1 });
});

// =====================
// CATCH ALL
// =====================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`BMF Shop démarré sur le port ${PORT}`);
  });
}).catch(err => {
  console.error('Impossible de démarrer sans MongoDB:', err.message);
  process.exit(1);
});
