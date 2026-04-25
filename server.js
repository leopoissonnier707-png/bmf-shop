const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// =====================
// CONFIG
// =====================
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ADMIN_DISCORD_ID = process.env.ADMIN_DISCORD_ID;
const SESSION_SECRET = process.env.SESSION_SECRET || 'bmfsecret';
const REDIRECT_URL = process.env.REDIRECT_URL || `http://localhost:${PORT}/auth/callback`;

// =====================
// MIDDLEWARE
// =====================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

// =====================
// AUTH DISCORD OAUTH2
// =====================

// Redirige vers Discord pour login
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URL,
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// Callback après login Discord
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/');

  try {
    // Échange le code contre un token
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

    // Récupère l'utilisateur Discord
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const user = userRes.data;
    req.session.user = {
      id: user.id,
      username: user.username,
      avatar: user.avatar
    };
    req.session.isAdmin = (user.id === ADMIN_DISCORD_ID);

    res.redirect('/');
  } catch (err) {
    console.error('Erreur OAuth2:', err.message);
    res.redirect('/');
  }
});

// Déconnexion
app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// =====================
// API
// =====================

// Récupère la session utilisateur
app.get('/api/me', (req, res) => {
  if (req.session.user) {
    res.json({ user: req.session.user, isAdmin: req.session.isAdmin });
  } else {
    res.json({ user: null, isAdmin: false });
  }
});

// Soumet une commande → envoie un message webhook Discord
app.post('/api/order', async (req, res) => {
  const { pseudo, gang, phone, items, total } = req.body;

  if (!pseudo || !gang || !phone || !items || !total) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  const itemsList = items.map(i => `• **${i.name}** x${i.qty} — ${i.sub.toLocaleString('fr-FR')}€`).join('\n');

  const embed = {
    embeds: [{
      title: '🔫 Nouvelle commande BMF',
      color: 0x00d4c8,
      fields: [
        { name: '👤 Pseudo illégal', value: pseudo, inline: true },
        { name: '🏴 Groupe', value: gang, inline: true },
        { name: '📞 Téléphone RP', value: phone, inline: true },
        { name: '📦 Articles commandés', value: itemsList },
        { name: '💰 Total argent sale', value: `**${total.toLocaleString('fr-FR')}€**`, inline: true }
      ],
      footer: { text: 'BMF Shop · Commande en attente de traitement' },
      timestamp: new Date().toISOString()
    }]
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL, embed);
    res.json({ success: true });
  } catch (err) {
    console.error('Erreur webhook:', err.message);
    res.status(500).json({ error: 'Erreur envoi Discord' });
  }
});

// Notifie le client (webhook) que la commande est prête
app.post('/api/order/done', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });

  const { pseudo, gang, slots } = req.body;

  const embed = {
    embeds: [{
      title: '✅ Commande prête — BMF',
      color: 0x4ade80,
      description: `La commande de **${pseudo}** (${gang}) est prête à être livrée.`,
      fields: [
        { name: '📅 Créneaux proposés', value: slots.join('\n') }
      ],
      footer: { text: 'BMF Shop · Choisissez votre créneau' },
      timestamp: new Date().toISOString()
    }]
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur webhook' });
  }
});

// =====================
// FALLBACK → index.html
// =====================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`BMF Shop démarré sur le port ${PORT}`);
});
