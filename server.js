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
const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_WEBHOOK_URL,
  ADMIN_DISCORD_ID,
  BOT_TOKEN,
  DISCORD_GUILD_ID,
  MONGO_URI,
  NODE_ENV
} = process.env;

const SESSION_SECRET = process.env.SESSION_SECRET || 'undergroundsecret2024';
const REDIRECT_URL = process.env.REDIRECT_URL || `http://localhost:${PORT}/auth/callback`;

// =====================
// BASE DE DONNÉES MONGODB
// =====================
const mongoClient = new MongoClient(MONGO_URI);
let db = null;

async function connectDB() {
  if (!db) {
    await mongoClient.connect();
    db = mongoClient.db('undergroundshop');
  }
  return db;
}

async function readJSON(collectionName, defValue = []) {
  try {
    const database = await connectDB();
    const docs = await database.collection(collectionName).find({}).toArray();
    return docs.length ? docs : defValue;
  } catch (e) {
    console.error(`DB read error on [${collectionName}]:`, e.message);
    return defValue;
  }
}

async function initDB() {
  try {
    const database = await connectDB();
    
    // Initialisation promos par défaut
    const promosCount = await database.collection('promos').countDocuments();
    if (promosCount === 0) {
      await database.collection('promos').insertOne({
        code: 'UNDERGROUNDVIP',
        discount: 10,
        active: true,
        usages: 0,
        createdAt: new Date().toISOString()
      });
    }

    console.log('✅ MongoDB connecté et initialisé avec succès !');
  } catch (e) {
    console.error('❌ Erreur connexion MongoDB:', e.message);
    throw e;
  }
}

// Vérifie si l'utilisateur est banni du serveur Discord
async function isUserBanned(userId) {
  if (!BOT_TOKEN || !DISCORD_GUILD_ID) return false;
  try {
    await axios.get(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/bans/${userId}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    return true; // Status 200 = Banni !
  } catch (err) {
    return false; // Status 404 = Non banni
  }
}

// Récupération globale des permissions d'un utilisateur
async function getUserPermissions(userId) {
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
    const database = await connectDB();
    const adminDirect = await database.collection('admins').findOne({ id: userId });

    let userRoleIds = [];
    if (BOT_TOKEN && DISCORD_GUILD_ID) {
      try {
        const memberRes = await axios.get(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${userId}`, {
          headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });
        userRoleIds = memberRes.data.roles || [];
      } catch (e) {
        console.error('Erreur récupération membre Discord:', e.message);
      }
    }

    const roleConfigs = await database.collection('role_permissions').find({ roleId: { $in: userRoleIds } }).toArray();

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

// =====================
// MIDDLEWARES
// =====================
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ 
    mongoUrl: MONGO_URI, 
    dbName: 'undergroundshop',
    ttl: 7 * 24 * 60 * 60 // Expire après 7 jours
  }),
  cookie: {
    secure: NODE_ENV === 'production',
    sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const checkPerm = (permName) => async (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const perms = await getUserPermissions(req.session.user.id);
  if (perms[permName] || perms.isAdmin || req.session.user.id === ADMIN_DISCORD_ID) {
    req.userPerms = perms;
    return next();
  }
  return res.status(403).json({ error: 'Permission refusée' });
};

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
        code: String(code),
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

    // VÉRIFICATION SI L'UTILISATEUR EST BANNI DU DISCORD
    const banned = await isUserBanned(user.id);
    if (banned) {
      return res.status(403).send('<h1 style="color:red;text-align:center;margin-top:50px;">⛔ Accès Refusé</h1><p style="text-align:center;">Vous êtes banni du serveur Discord Underground. Accès au site impossible.</p>');
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar,
      globalName: user.global_name || user.username
    };

    const perms = await getUserPermissions(user.id);
    req.session.isAdmin = perms.isAdmin;

    res.redirect('/');
  } catch (err) {
    console.error('Erreur OAuth2:', err.response?.data || err.message);
    res.redirect('/');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// =====================
// API — UTILISATEUR
// =====================
app.get('/api/me', async (req, res) => {
  if (!req.session.user) {
    return res.json({ user: null, isAdmin: false, perms: {} });
  }

  const banned = await isUserBanned(req.session.user.id);
  if (banned) {
    req.session.destroy();
    return res.json({ user: null, isAdmin: false, perms: {} });
  }

  const perms = await getUserPermissions(req.session.user.id);
  req.session.isAdmin = perms.isAdmin;
  res.json({ user: req.session.user, isAdmin: perms.isAdmin, perms });
});

// =====================
// API — ARMES / CATALOGUE
// =====================
app.get('/api/weapons', async (req, res) => {
  res.json(await readJSON('weapons', []));
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

  try {
    const database = await connectDB();
    await database.collection('weapons').insertOne(weapon);
    res.json({ success: true, weapon });
  } catch(e) { 
    res.status(500).json({ error: 'Erreur DB' }); 
  }
});

app.put('/api/weapons/:id', checkPerm('canManageWeapons'), async (req, res) => {
  try {
    const database = await connectDB();
    const { _id, ...update } = req.body;
    await database.collection('weapons').updateOne({ id: parseInt(req.params.id, 10) }, { $set: update });
    res.json({ success: true });
  } catch(e) { 
    res.status(500).json({ error: 'Erreur DB' }); 
  }
});

app.delete('/api/weapons/:id', checkPerm('canDeleteWeapons'), async (req, res) => {
  try {
    const database = await connectDB();
    await database.collection('weapons').deleteOne({ id: parseInt(req.params.id, 10) });
    res.json({ success: true });
  } catch(e) { 
    res.status(500).json({ error: 'Erreur DB' }); 
  }
});

app.delete('/api/weapons/by-name', checkPerm('canDeleteWeapons'), async (req, res) => {
  const { exactName } = req.body;
  if (!exactName) return res.status(400).json({ error: 'Nom exact requis' });

  try {
    const database = await connectDB();
    const result = await database.collection('weapons').deleteOne({ name: exactName.trim() });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Aucun article trouvé avec ce nom exact.' });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

// =====================
// API — CODES PROMO
// =====================
app.get('/api/promos', checkPerm('canManagePromos'), async (req, res) => {
  const database = await connectDB();
  res.json(await database.collection('promos').find({}).toArray());
});

app.post('/api/promos', checkPerm('canManagePromos'), async (req, res) => {
  const { code, discount } = req.body;
  if (!code || !discount) return res.status(400).json({ error: 'Champs manquants' });

  const database = await connectDB();
  const formattedCode = code.toUpperCase().trim();

  const exists = await database.collection('promos').findOne({ code: formattedCode });
  if (exists) return res.status(400).json({ error: 'Code déjà existant' });

  const promo = { 
    code: formattedCode, 
    discount: parseInt(discount, 10), 
    active: true, 
    usages: 0, 
    createdAt: new Date().toISOString() 
  };
  
  await database.collection('promos').insertOne(promo);
  res.json({ success: true, promo });
});

app.delete('/api/promos/:code', checkPerm('canManagePromos'), async (req, res) => {
  const database = await connectDB();
  await database.collection('promos').deleteOne({ code: req.params.code.toUpperCase() });
  res.json({ success: true });
});

app.post('/api/promos/check', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code requis' });

  const database = await connectDB();
  const promo = await database.collection('promos').findOne({ code: code.toUpperCase().trim(), active: true });
  
  if (!promo) return res.status(404).json({ error: 'Code invalide ou inactif' });
  res.json({ discount: promo.discount, code: promo.code });
});

// =====================
// API — COMMANDES
// =====================
app.get('/api/orders', checkPerm('canManageOrders'), async (req, res) => {
  const database = await connectDB();
  const orders = await database.collection('orders').find({}).sort({ createdAt: -1 }).toArray();
  res.json(orders);
});

app.post('/api/order', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });

  const { pseudo, gang, phone, signature, items, total, promoCode, discount } = req.body;
  const user = req.session.user;

  if (!pseudo || !gang || !phone || !signature || !Array.isArray(items) || items.length === 0 || total === undefined) {
    return res.status(400).json({ error: 'Champs manquants ou invalides' });
  }

  const database = await connectDB();

  if (promoCode) {
    try {
      await database.collection('promos').updateOne({ code: promoCode.toUpperCase() }, { $inc: { usages: 1 } });
    } catch(e) {
      console.error('Erreur maj usage promo:', e.message);
    }
  }

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  const itemsList = items.map(i => `• **${i.name}** x${i.qty} — ${Number(i.sub).toLocaleString('fr-FR')}€`).join('\n');
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
    await database.collection('orders').insertOne(order);
  } catch(e) { 
    console.error('Erreur sauvegarde commande:', e.message); 
    return res.status(500).json({ error: 'Erreur lors de la sauvegarde' });
  }

  if (DISCORD_WEBHOOK_URL) {
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
          { name: '💰 Total argent sale', value: `**${Number(total).toLocaleString('fr-FR')}€**`, inline: true },
          { name: '🆔 Discord ID', value: user.id, inline: true },
          { name: '🔖 ID Commande', value: `#${order.id}`, inline: true }
        ],
        footer: { text: `Underground Shop · Commande #${order.id} · EN ATTENTE` },
        timestamp: new Date().toISOString()
      }],
      content: `📦 **Nouvelle commande** de ${user.username} | ID: \`${order.id}\``
    };

    try {
      await axios.post(`${DISCORD_WEBHOOK_URL}?wait=true`, embed);
    } catch (err) {
      console.error('Erreur Webhook Discord:', err.response?.data || err.message);
    }
  }

  res.json({ success: true, orderId: order.id });
});

app.post('/api/order/done', checkPerm('canManageOrders'), async (req, res) => {
  const { orderId, discordId, pseudo } = req.body;
  const staffUser = req.session.user;

  try {
    const database = await connectDB();
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
  } catch(e) { 
    console.error('Erreur update order:', e.message); 
    return res.status(500).json({ error: 'Erreur serveur' });
  }

  if (BOT_TOKEN && discordId) {
    try {
      const dmRes = await axios.post(
        'https://discord.com/api/v10/users/@me/channels',
        { recipient_id: discordId },
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      
      const channelId = dmRes.data.id;
      await axios.post(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        {
          embeds: [{
            title: '✅ Votre commande Underground est prête !',
            color: 0x4ade80,
            description: `Bonjour **${pseudo}** ! 🎮\n\nVotre commande sur **Underground Shop** est prête.\nTraité par le staff: **${staffUser.username}**.\nVous serez contacté **en jeu** très prochainement par un membre du staff pour la livraison.\n\nMerci de votre confiance ! 🔫`,
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

  res.json({ success: true });
});

app.delete('/api/order/:id', checkPerm('canManageOrders'), async (req, res) => {
  try {
    const database = await connectDB();
    await database.collection('orders').deleteOne({ id: parseInt(req.params.id, 10) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur lors de la suppression de la commande' });
  }
});

// =====================
// API — ADMINS
// =====================
app.get('/api/admins', checkPerm('canManageRoles'), async (req, res) => {
  const database = await connectDB();
  res.json(await database.collection('admins').find({}).toArray());
});

app.post('/api/admins', checkPerm('canManageRoles'), async (req, res) => {
  const { id, note } = req.body;
  if (!id) return res.status(400).json({ error: 'ID manquant' });

  const database = await connectDB();
  const exists = await database.collection('admins').findOne({ id });
  if (exists) return res.status(400).json({ error: 'Admin déjà existant' });

  await database.collection('admins').insertOne({ id, note: note || '', addedAt: new Date().toISOString() });
  res.json({ success: true });
});

app.delete('/api/admins/:id', checkPerm('canManageRoles'), async (req, res) => {
  const database = await connectDB();
  await database.collection('admins').deleteOne({ id: req.params.id });
  res.json({ success: true });
});

// =====================
// API — RÔLES & MEMBRES DISCORD
// =====================
app.get('/api/roles', checkPerm('canManageRoles'), async (req, res) => {
  if (!BOT_TOKEN || !DISCORD_GUILD_ID) {
    return res.status(400).json({ error: 'BOT_TOKEN ou DISCORD_GUILD_ID manquant' });
  }
  try {
    const [rolesRes, membersRes] = await Promise.all([
      axios.get(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/roles`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` }
      }),
      axios.get(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members?limit=1000`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` }
      })
    ]);

    const database = await connectDB();
    const savedPerms = await database.collection('role_permissions').find({}).toArray();
    const permMap = savedPerms.reduce((acc, p) => ({ ...acc, [p.roleId]: p }), {});

    const members = membersRes.data;

    const roles = rolesRes.data
      .filter(r => r.name !== '@everyone')
      .sort((a, b) => b.position - a.position)
      .map(r => {
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
          color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : '#99aab5',
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
    console.error('Erreur récupération rôles Discord:', err.response?.data || err.message);
    res.status(500).json({ error: 'Impossible de récupérer les rôles Discord' });
  }
});

app.post('/api/roles/:roleId/permissions', checkPerm('canManageRoles'), async (req, res) => {
  const { roleId } = req.params;
  const permissions = req.body;

  const database = await connectDB();
  await database.collection('role_permissions').updateOne(
    { roleId },
    { $set: { roleId, ...permissions, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );

  res.json({ success: true });
});

// =====================
// API — RECHERCHE / LOGS PAR DISCORD ID
// =====================
app.get('/api/logs/user/:discordId', checkPerm('canViewLogs'), async (req, res) => {
  const { discordId } = req.params;
  const database = await connectDB();

  const [userOrders, processedOrders] = await Promise.all([
    database.collection('orders').find({ discordId }).sort({ createdAt: -1 }).toArray(),
    database.collection('orders').find({ processedBy: discordId }).sort({ doneAt: -1 }).toArray()
  ]);

  res.json({
    discordId,
    ordersPlaced: userOrders,
    ordersProcessed: processedOrders
  });
});

// =====================
// API — STATS
// =====================
app.get('/api/stats', checkPerm('canManageOrders'), async (req, res) => {
  const database = await connectDB();
  
  const [orders, weaponCount, adminCount] = await Promise.all([
    database.collection('orders').find({}).toArray(),
    database.collection('weapons').countDocuments(),
    database.collection('admins').countDocuments()
  ]);

  const pending = orders.filter(o => o.status === 'pending').length;
  const done = orders.filter(o => o.status === 'done').length;
  const totalRevenue = orders.filter(o => o.status === 'done').reduce((acc, o) => acc + (o.total || 0), 0);

  res.json({ 
    pending, 
    done, 
    total: orders.length, 
    totalRevenue, 
    weaponCount, 
    adminCount: adminCount + 1 
  });
});

// =====================
// CATCH ALL
// =====================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Démarrage du serveur
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Underground Shop démarré sur le port ${PORT}`);
  });
}).catch(err => {
  console.error('💥 Impossible de démarrer sans MongoDB:', err.message);
  process.exit(1);
});
