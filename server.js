
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

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
// PERSISTANCE JSON (fichiers)
// =====================
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function readJSON(file, def) {
  const fp = path.join(DATA_DIR, file);
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// Initialisation des fichiers si absents
if (!fs.existsSync(path.join(DATA_DIR, 'orders.json'))) writeJSON('orders.json', []);
if (!fs.existsSync(path.join(DATA_DIR, 'admins.json'))) writeJSON('admins.json', []);
if (!fs.existsSync(path.join(DATA_DIR, 'weapons.json'))) writeJSON('weapons.json', [
  { id:1, name:'Machine Pistol', cat:'Pistolet', price:1200000, desc:'Une arme automatique compacte mais puissante.', photos:[] },
  { id:2, name:'Fusil à canon scié', cat:'Fusil', price:2000000, desc:'Un fusil brutal pour les combats à courte portée.', photos:[] },
  { id:3, name:'AK-47', cat:'Fusil', price:2250000, desc:"Fusil d'assaut lourd et redoutable.", photos:[] },
  { id:4, name:'AK-U', cat:'Fusil', price:2500000, desc:"Version compacte d'un fusil d'assaut.", photos:[] },
]);
if (!fs.existsSync(path.join(DATA_DIR, 'promos.json'))) writeJSON('promos.json', [
  { code:'BMFVIP', discount:10, active:true, usages:0, createdAt: new Date().toISOString() },
]);

// =====================
// ADMIN CHECK
// =====================
function isAdminId(id) {
  if (id === ADMIN_DISCORD_ID) return true;
  const admins = readJSON('admins.json', []);
  return admins.some(a => a.id === id);
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
    req.session.isAdmin = isAdminId(user.id);
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
app.get('/api/me', (req, res) => {
  if (req.session.user) {
    req.session.isAdmin = isAdminId(req.session.user.id);
    res.json({ user: req.session.user, isAdmin: req.session.isAdmin });
  } else {
    res.json({ user: null, isAdmin: false });
  }
});

// =====================
// API — ARMES (lecture publique, écriture admin)
// =====================
app.get('/api/weapons', (req, res) => {
  res.json(readJSON('weapons.json', []));
});

app.post('/api/weapons', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const weapons = readJSON('weapons.json', []);
  const { name, cat, price, desc, photos } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Champs manquants' });
  const weapon = { id: Date.now(), name, cat: cat || 'Autre', price: parseInt(price), desc: desc || '', photos: photos || [] };
  weapons.push(weapon);
  writeJSON('weapons.json', weapons);
  res.json({ success: true, weapon });
});

app.put('/api/weapons/:id', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  let weapons = readJSON('weapons.json', []);
  const idx = weapons.findIndex(w => w.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  weapons[idx] = { ...weapons[idx], ...req.body, id: weapons[idx].id };
  writeJSON('weapons.json', weapons);
  res.json({ success: true });
});

app.delete('/api/weapons/:id', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  let weapons = readJSON('weapons.json', []);
  weapons = weapons.filter(w => w.id != req.params.id);
  writeJSON('weapons.json', weapons);
  res.json({ success: true });
});

// =====================
// API — CODES PROMO
// =====================
app.get('/api/promos', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  res.json(readJSON('promos.json', []));
});

app.post('/api/promos', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const promos = readJSON('promos.json', []);
  const { code, discount } = req.body;
  if (!code || !discount) return res.status(400).json({ error: 'Champs manquants' });
  if (promos.find(p => p.code.toUpperCase() === code.toUpperCase())) return res.status(400).json({ error: 'Code déjà existant' });
  const promo = { code: code.toUpperCase(), discount: parseInt(discount), active: true, usages: 0, createdAt: new Date().toISOString() };
  promos.push(promo);
  writeJSON('promos.json', promos);
  res.json({ success: true, promo });
});

app.delete('/api/promos/:code', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  let promos = readJSON('promos.json', []);
  promos = promos.filter(p => p.code !== req.params.code);
  writeJSON('promos.json', promos);
  res.json({ success: true });
});

app.post('/api/promos/check', (req, res) => {
  const { code } = req.body;
  const promos = readJSON('promos.json', []);
  const promo = promos.find(p => p.code === code?.toUpperCase() && p.active);
  if (!promo) return res.status(404).json({ error: 'Code invalide ou inactif' });
  res.json({ discount: promo.discount, code: promo.code });
});

// =====================
// API — COMMANDES
// =====================
app.get('/api/orders', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  res.json(readJSON('orders.json', []));
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
    const promos = readJSON('promos.json', []);
    const idx = promos.findIndex(p => p.code === promoCode);
    if (idx !== -1) { promos[idx].usages = (promos[idx].usages || 0) + 1; writeJSON('promos.json', promos); }
  }

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  const itemsList = items.map(i => `• **${i.name}** x${i.qty} — ${i.sub.toLocaleString('fr-FR')}€`).join('\n');
  const promoLine = promoCode ? `\n🏷️ Code promo: **${promoCode}** (-${discount}%)` : '';

  // Sauvegarder la commande côté serveur
  const orders = readJSON('orders.json', []);
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
  orders.unshift(order); // plus récent en premier
  writeJSON('orders.json', orders);

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

  // Mettre à jour le statut de la commande
  const orders = readJSON('orders.json', []);
  const idx = orders.findIndex(o => o.id == orderId);
  if (idx !== -1) {
    orders[idx].status = 'done';
    orders[idx].doneAt = new Date().toISOString();
    writeJSON('orders.json', orders);
  }

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

app.delete('/api/order/:id', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  let orders = readJSON('orders.json', []);
  orders = orders.filter(o => o.id != req.params.id);
  writeJSON('orders.json', orders);
  res.json({ success: true });
});

// =====================
// API — ADMINS
// =====================
app.get('/api/admins', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  res.json(readJSON('admins.json', []));
});

app.post('/api/admins', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const { id, note } = req.body;
  if (!id) return res.status(400).json({ error: 'ID manquant' });
  const admins = readJSON('admins.json', []);
  if (admins.find(a => a.id === id)) return res.status(400).json({ error: 'Admin déjà existant' });
  admins.push({ id, note: note || '', addedAt: new Date().toISOString() });
  writeJSON('admins.json', admins);
  res.json({ success: true });
});

app.delete('/api/admins/:id', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  let admins = readJSON('admins.json', []);
  admins = admins.filter(a => a.id !== req.params.id);
  writeJSON('admins.json', admins);
  res.json({ success: true });
});

// =====================
// API — STATS
// =====================
app.get('/api/stats', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });
  const orders = readJSON('orders.json', []);
  const pending = orders.filter(o => o.status === 'pending').length;
  const done = orders.filter(o => o.status === 'done').length;
  const totalRevenue = orders.filter(o => o.status === 'done').reduce((a, o) => a + o.total, 0);
  const weapons = readJSON('weapons.json', []);
  const admins = readJSON('admins.json', []);
  res.json({ pending, done, total: orders.length, totalRevenue, weaponCount: weapons.length, adminCount: admins.length + 1 });
});

// =====================
// CATCH ALL
// =====================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`BMF Shop démarré sur le port ${PORT}`);
});
