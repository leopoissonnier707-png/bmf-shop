const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ADMIN_DISCORD_ID = process.env.ADMIN_DISCORD_ID;
const SESSION_SECRET = process.env.SESSION_SECRET || 'bmfsecret';
const REDIRECT_URL = process.env.REDIRECT_URL || `http://localhost:${PORT}/auth/callback`;
const BOT_TOKEN = process.env.BOT_TOKEN;

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
    req.session.isAdmin = (user.id === ADMIN_DISCORD_ID);
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
// API
// =====================
app.get('/api/me', (req, res) => {
  if (req.session.user) {
    res.json({ user: req.session.user, isAdmin: req.session.isAdmin });
  } else {
    res.json({ user: null, isAdmin: false });
  }
});

// Soumettre une commande
app.post('/api/order', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Non connecté' });
  }

  const { pseudo, gang, phone, signature, items, total } = req.body;
  const user = req.session.user;

  if (!pseudo || !gang || !phone || !signature || !items || !total) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  const itemsList = items.map(i => `• **${i.name}** x${i.qty} — ${i.sub.toLocaleString('fr-FR')}€`).join('\n');

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
        { name: '📦 Articles commandés', value: itemsList },
        { name: '💰 Total argent sale', value: `**${total.toLocaleString('fr-FR')}€**`, inline: true },
        { name: '🆔 Discord ID', value: user.id, inline: true }
      ],
      footer: { text: `BMF Shop · Commande en attente · ID: ${user.id}` },
      timestamp: new Date().toISOString()
    }],
    // Bouton terminer via components (webhook simple, pas de bot)
    content: `📦 **Nouvelle commande** de ${user.username} | ID client: \`${user.id}\``
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL + '?wait=true', embed);
    res.json({ success: true });
  } catch (err) {
    console.error('Erreur webhook:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erreur envoi Discord' });
  }
});

// Notifier le client que la commande est prête (MP via bot)
app.post('/api/order/done', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Non autorisé' });

  const { discordId, pseudo } = req.body;

  if (!BOT_TOKEN) {
    return res.status(500).json({ error: 'BOT_TOKEN non configuré' });
  }

  try {
    // Créer un DM channel avec l'utilisateur
    const dmRes = await axios.post(`https://discord.com/api/v10/users/@me/channels`,
      { recipient_id: discordId },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    const channelId = dmRes.data.id;

    // Envoyer le message MP
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

    res.json({ success: true });
  } catch (err) {
    console.error('Erreur MP Discord:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erreur envoi MP' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`BMF Shop démarré sur le port ${PORT}`);
});
