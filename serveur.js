const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const axios = require('axios');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// =====================
// CONFIGURATION
// =====================
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ADMIN_DISCORD_ID = process.env.ADMIN_DISCORD_ID;
const SESSION_SECRET = process.env.SESSION_SECRET || 'undergroundsecret2024';
const REDIRECT_URL = process.env.REDIRECT_URL || `http://localhost:${PORT}/auth/callback`;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const MONGO_URI = process.env.MONGO_URI;

// =====================
// BASE DE DONNÉES MONGODB
// =====================
let db = null;

async function getDB() {
  if (db) return db;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('undergroundshop');
  return db;
}

// System de permissions par rôle ou par ID (Admin suprême = tout les droits)
async function getUserPermissions(userId) {
  // 1. Fondateur / Admin Suprême
  if (userId === ADMIN_DISCORD_ID) {
    return {
      isAdmin: true,
      canManageWeapons: true,
      canDeleteWeapons: true,
      canManageOrders: true,
      canManagePromos: true,
      canManageRoles: true,
      canViewLogs: true
    };
  }

  try {
    const database = await getDB();
    
    // Vérifier si inscrit en admin direct
    const adminDirect = await database.collection('admins').findOne({ id: userId });

    // Récupérer les rôles Discord du membre
    let userRoleIds = [];
    if (BOT_TOKEN && DISCORD_GUILD_ID) {
      try {
        const memberRes = await axios.get(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${userId}`, {
          headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });
        userRoleIds = memberRes.data.roles || [];
      } catch (e) {
        console.error('Erreur fetch membre Discord:', e.response?.status || e.message);
      }
    }

    // Récupérer les permissions configurées en DB pour ces rôles
    const roleConfigs = await database.collection('role_permissions').find({ roleId: { $in: userRoleIds } }).toArray();

    // Cumuler les permissions
    const perms = {
      isAdmin: !!adminDirect,
      canManageWeapons: false,
      canDeleteWeapons: false,
      canManageOrders: false,
      canManagePromos: false,
      canManageRoles: false,
      canViewLogs: false
    };

    roleConfigs.forEach(r => {
      if (r.isAdmin) perms.isAdmin = true;
      if (r.canManageWeapons) perms.canManageWeapons = true;
      if (r.canDeleteWeapons) perms.canDeleteWeapons = true;
      if (r.canManageOrders) perms.canManageOrders = true;
      if (r.canManagePromos) perms.canManagePromos = true;
      if (r.canManageRoles) perms.canManageRoles = true;
      if (r.canViewLogs) perms.canViewLogs = true;
    });

    return perms;
  } catch (e) {
    return { isAdmin: false };
  }
}

// Vérifie si le membre est banni du serveur Discord
async function isUserBanned(userId) {
  if (!BOT_TOKEN || !DISCORD_GUILD_ID) return false;
  try {
    await axios.get(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/bans/${userId}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    return true; // S'il renvoie 200, il est banni !
  } catch (err) {
    return false; // 404 = non banni
  }
}

// =====================
// MIDDLEWARES DE SÉCURITÉ
// =====================
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URI, dbName: 'undergroundshop' }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

// Middleware d'autorisation dynamique
const checkPerm = (permName) => async (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const perms = await getUserPermissions(req.session.user.id);
  
  if (perms[permName] || perms.isAdmin || req.session.user.id === ADMIN_DISCORD_ID) {
    req.userPerms = perms;
    return next();
  }
  return res.status(403).json({ error: 'Permission refusée pour cette action' });
};

// =====================
// AUTHENTIFICATION DISCORD + VÉRIFICATION BAN
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

    // VÉRIFICATION DU BAN
    const banned = await isUserBanned(user.id);
    if (banned) {
      return res.status(403).send('<h1>⛔ Accès Refusé</h1><p>Vous êtes banni du serveur Discord Underground. Accès au site impossible.</p><a href="/">Retour</a>');
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      globalName: user.global_name || user.username
    };

    req.session.perms = await getUserPermissions(user.id);
    res.redirect('/');
  } catch (err) {
    console.error('Erreur OAuth2:', err.message);
    res.redirect('/');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/api/me', async (req, res) => {
  if (req.session.user) {
    // Vérification du Ban en temps réel lors du fetch
    const banned = await isUserBanned(req.session.user.id);
    if (banned) {
      req.session.destroy();
      return res.json({ user: null, perms: {} });
    }
    const perms = await getUserPermissions(req.session.user.id);
    res.json({ user: req.session.user, perms });
  } else {
    res.json({ user: null, perms: {} });
  }
});

// =====================
// API — CATALOGUE (AJOUT / SUPPRESSION PAR NOM EXACT)
// =====================
app.get('/api/weapons', async (req, res) => {
  const database = await getDB();
  res.json(await database.collection('weapons').find({}).toArray());
});

app.post('/api/weapons', checkPerm('canManageWeapons'), async (req, res) => {
  const { name, cat, price, desc, photos, currency } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Champs manquants' });

  const weapon = {
    id: Date.now(),
    name,
    cat: cat || 'Autre',
    price: parseInt(price, 10),
    desc: desc || '',
    photos: photos || [],
    currency: currency || 'sale'
  };

  const database = await getDB();
  await database.collection('weapons').insertOne(weapon);
  res.json({ success: true, weapon });
});

// SUPPRESSION PAR NOM EXACT AVEC CONFIRMATION
app.delete('/api/weapons/by-name', checkPerm('canDeleteWeapons'), async (req, res) => {
  const { exactName } = req.body;
  if (!exactName) return res.status(400).json({ error: 'Nom exact requis pour la suppression' });

  const database = await getDB();
  const result = await database.collection('weapons').deleteOne({ name: exactName.trim() });

  if (result.deletedCount === 0) {
    return res.status(404).json({ error: 'Aucun article trouvé avec ce nom exact.' });
  }

  res.json({ success: true, message: `Article "${exactName}" supprimé avec succès.` });
});

// =====================
// API — CONFIGURATION RÔLES & PERMISSIONS
// =====================
app.get('/api/roles', checkPerm('canManageRoles'), async (req, res) => {
  if (!BOT_TOKEN || !DISCORD_GUILD_ID) {
    return res.status(400).json({ error: 'BOT_TOKEN ou DISCORD_GUILD_ID manquant' });
  }
  try {
    // 1. Récupérer les rôles du serveur Discord
    const rolesRes = await axios.get(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/roles`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });

    // 2. Récupérer tous les membres pour compter et lister qui a quel rôle
    const membersRes = await axios.get(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members?limit=1000`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });

    // 3. Récupérer les permissions stockées dans la base de données
    const database = await getDB();
    const savedPerms = await database.collection('role_permissions').find({}).toArray();
    const permMap = savedPerms.reduce((acc, p) => ({ ...acc, [p.roleId]: p }), {});

    const members = membersRes.data;

    const roles = rolesRes.data
      .filter(r => r.name !== '@everyone')
      .sort((a, b) => b.position - a.position)
      .map(r => {
        // Trouver tous les membres ayant ce rôle
        const roleMembers = members
          .filter(m => m.roles.includes(r.id))
          .map(m => ({
            id: m.user.id,
            username: m.user.username,
            globalName: m.user.global_name || m.user.username,
            avatar: m.user.avatar
          }));

        return {
          id: r.id,
          name: r.name,
          color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : '#99aab5',
          memberCount: roleMembers.length,
          members: roleMembers,
          permissions: permMap[r.id] || {
            isAdmin: false,
            canManageWeapons: false,
            canDeleteWeapons: false,
            canManageOrders: false,
            canManagePromos: false,
            canManageRoles: false,
            canViewLogs: false
          }
        };
      });

    res.json(roles);
  } catch (err) {
    console.error('Erreur API Discord Roles:', err.response?.data || err.message);
    res.status(500).json({ error: 'Impossible de récupérer la liste des rôles Discord' });
  }
});

// Mettre à jour les permissions d'un rôle
app.post('/api/roles/:roleId/permissions', checkPerm('canManageRoles'), async (req, res) => {
  const { roleId } = req.params;
  const permissions = req.body; // Object contant les booléens

  const database = await getDB();
  await database.collection('role_permissions').updateOne(
    { roleId },
    { $set: { roleId, ...permissions, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );

  res.json({ success: true });
});

// =====================
// API — RECHERCHE & LOGS PAR DISCORD ID
// =====================
app.get('/api/logs/user/:discordId', checkPerm('canViewLogs'), async (req, res) => {
  const { discordId } = req.params;
  const database = await getDB();

  // 1. Commandes passées par cet utilisateur
  const userOrders = await database.collection('orders')
    .find({ discordId })
    .sort({ createdAt: -1 })
    .toArray();

  // 2. Commandes acceptées/traitées par ce staff
  const processedOrders = await database.collection('orders')
    .find({ processedBy: discordId })
    .sort({ doneAt: -1 })
    .toArray();

  res.json({
    discordId,
    ordersPlaced: userOrders,
    ordersProcessed: processedOrders
  });
});

// =====================
// API — COMMANDES (ACCEPTATION AVEC LOG STAFF)
// =====================
app.post('/api/order/done', checkPerm('canManageOrders'), async (req, res) => {
  const { orderId, discordId, pseudo } = req.body;
  const staffUser = req.session.user;

  const database = await getDB();
  await database.collection('orders').updateOne(
    { id: parseInt(orderId, 10) },
    { 
      $set: { 
        status: 'done', 
        doneAt: new Date().toISOString(),
        processedBy: staffUser.id,
        processedByName: staffUser.username
      } 
    }
  );

  // Envoi MP Discord
  if (BOT_TOKEN && discordId) {
    try {
      const dmRes = await axios.post(`https://discord.com/api/v10/users/@me/channels`,
        { recipient_id: discordId },
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      await axios.post(`https://discord.com/api/v10/channels/${dmRes.data.id}/messages`,
        {
          embeds: [{
            title: '✅ Votre commande Underground est prête !',
            color: 0x4ade80,
            description: `Bonjour **${pseudo}** !\n\nVotre commande a été traitée et validée.\nVous serez livré prochainement en jeu par l'équipe.`,
            footer: { text: 'Underground Black Market' },
            timestamp: new Date().toISOString()
          }]
        },
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
    } catch (err) {}
  }

  res.json({ success: true });
});

// Start Server
getDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Underground Server actif sur le port ${PORT}`));
});
