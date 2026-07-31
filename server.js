const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits } = require('discord.js');
const { PERMISSIONS } = require('./config/permissions');

const app = express();
app.use(express.json());
app.use(cors());

// Config Discord Bot
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans
  ]
});

if (process.env.DISCORD_BOT_TOKEN) {
  client.login(process.env.DISCORD_BOT_TOKEN).catch(console.error);
}

// ------------------------------------------------------------------
// Base de données temporaire / En mémoire (À relier à MongoDB si besoin)
// ------------------------------------------------------------------
let roleConfigs = {}; // Stocke les permissions par ID de rôle : { "ROLE_ID": ["access_panel", "manage_orders"] }
let catalogItems = [
  { id: 1, name: 'Pistolet MK2', category: 'Armes', price: 150000, description: 'Arme de poing de base' }
];
let orders = [];
let logs = []; // Journal des actions système

// ------------------------------------------------------------------
// Middlewares de Sécurité
// ------------------------------------------------------------------

// 1. Vérifie si l'utilisateur est banni du serveur Discord
async function checkNotBanned(req, res, next) {
  // Remplace req.user par le système de session OAuth2 Discord de ton site
  const userId = req.headers['x-discord-user-id'] || (req.user && req.user.id);

  if (!userId) {
    return res.status(401).json({ error: 'Utilisateur non identifié.' });
  }

  try {
    if (client.isReady() && GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      const bans = await guild.bans.fetch();
      
      if (bans.has(userId)) {
        return res.status(403).json({ error: 'Accès refusé : vous êtes banni du serveur Discord.' });
      }
    }
    req.currentUserId = userId;
    next();
  } catch (err) {
    console.error('Erreur vérification ban Discord:', err);
    // En cas d'erreur de communication Discord, on laisse passer ou bloque selon la politique
    next();
  }
}

// 2. Calcule les permissions cumulées de l'utilisateur en fonction de ses rôles Discord
async function resolveUserPermissions(req, res, next) {
  const userId = req.currentUserId;
  let userPermissions = new Set();

  try {
    if (client.isReady() && GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(userId).catch(() => null);

      if (member) {
        // Parcours de tous les rôles du membre pour additionner leurs permissions configurées
        member.roles.cache.forEach(role => {
          const permsOfRole = roleConfigs[role.id] || [];
          permsOfRole.forEach(p => userPermissions.add(p));
        });
      }
    }
  } catch (err) {
    console.error('Erreur calcul permissions:', err);
  }

  req.userPermissions = Array.from(userPermissions);
  next();
}

// 3. Exige une permission spécifique pour exécuter une action
function requirePermission(permissionKey) {
  return (req, res, next) => {
    // Si la permission n'est pas présente dans les droits de l'utilisateur
    if (!req.userPermissions || !req.userPermissions.includes(permissionKey)) {
      return res.status(403).json({ 
        error: `Permission insuffisante. Vous devez posséder la permission : "${permissionKey}".` 
      });
    }
    next();
  };
}

// ------------------------------------------------------------------
// ROUTES : GESTION DES RÔLES & MEMBRES
// ------------------------------------------------------------------

// Obtenir la liste des rôles Discord avec le nombre de membres, la liste des membres et leurs permissions
app.get('/api/roles', checkNotBanned, resolveUserPermissions, async (req, res) => {
  try {
    if (!client.isReady() || !GUILD_ID) {
      return res.status(503).json({ error: 'Bot Discord non connecté.' });
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.roles.fetch();
    await guild.members.fetch();

    const rolesData = guild.roles.cache
      .filter(role => role.name !== '@everyone')
      .map(role => {
        const members = role.members.map(m => ({
          id: m.id,
          username: m.user.username,
          displayName: m.displayName,
          avatar: m.user.displayAvatarURL({ dynamic: true })
        }));

        return {
          id: role.id,
          name: role.name,
          color: role.hexColor,
          memberCount: members.length,
          members: members,
          permissions: roleConfigs[role.id] || []
        };
      });

    res.json(rolesData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des rôles Discord.' });
  }
});

// Sauvegarder les permissions attribuées à un rôle
app.put('/api/roles/:roleId/permissions', checkNotBanned, resolveUserPermissions, requirePermission(PERMISSIONS.MANAGE_ROLES), (req, res) => {
  const { roleId } = req.params;
  const { permissions } = req.body;

  if (!Array.isArray(permissions)) {
    return res.status(400).json({ error: 'Le format des permissions est invalide.' });
  }

  roleConfigs[roleId] = permissions;

  // Audit Log
  logs.push({
    executorId: req.currentUserId,
    action: `Modification des permissions du rôle ID ${roleId}`,
    details: permissions,
    timestamp: new Date()
  });

  res.json({ success: true, message: 'Permissions du rôle mises à jour.', permissions });
});

// ------------------------------------------------------------------
// ROUTES : CATALOGUE & SUPPRESSION SÉCURISÉE
// ------------------------------------------------------------------

// Récupérer les articles du catalogue
app.get('/api/catalog', (req, res) => {
  res.json(catalogItems);
});

// Ajouter un article au catalogue
app.post('/api/catalog', checkNotBanned, resolveUserPermissions, requirePermission(PERMISSIONS.ADD_CATALOG), (req, res) => {
  const { name, category, price, description } = req.body;

  if (!name || !price) {
    return res.status(400).json({ error: 'Champs manquants.' });
  }

  const newItem = {
    id: Date.now(),
    name,
    category: category || 'Général',
    price: Number(price),
    description: description || ''
  };

  catalogItems.push(newItem);

  logs.push({
    executorId: req.currentUserId,
    action: `Ajout d'un item au catalogue : ${name}`,
    timestamp: new Date()
  });

  res.status(201).json(newItem);
});

// Supprimer un article (Demande le nom exact pour valider)
app.delete('/api/catalog/delete-secure', checkNotBanned, resolveUserPermissions, requirePermission(PERMISSIONS.DELETE_CATALOG), (req, res) => {
  const { name, confirmationName } = req.body;

  if (!name || !confirmationName) {
    return res.status(400).json({ error: 'Nom et nom de confirmation requis.' });
  }

  if (name !== confirmationName) {
    return res.status(400).json({ error: 'Le nom de confirmation ne correspond pas exactement au nom de l’item.' });
  }

  const index = catalogItems.findIndex(item => item.name === name);
  if (index === -1) {
    return res.status(404).json({ error: 'Article introuvable dans le catalogue.' });
  }

  const deletedItem = catalogItems.splice(index, 1);

  logs.push({
    executorId: req.currentUserId,
    action: `Suppression de l'item catalogue : ${name}`,
    timestamp: new Date()
  });

  res.json({ success: true, message: `L'article "${name}" a été supprimé avec succès.`, deletedItem });
});

// ------------------------------------------------------------------
// ROUTES : RECHERCHE DE LOGS & HISTORIQUE PAR ID DISCORD
// ------------------------------------------------------------------

app.get('/api/user-logs/:discordId', checkNotBanned, resolveUserPermissions, requirePermission(PERMISSIONS.VIEW_USER_LOGS), (req, res) => {
  const { discordId } = req.params;

  // 1. Commandes passées par cet utilisateur
  const userOrders = orders.filter(o => o.userId === discordId);

  // 2. Commandes acceptées / gérées par cet utilisateur (si membre du staff)
  const handledOrders = orders.filter(o => o.staffId === discordId);

  // 3. Actions d'administration enregistrées par cet utilisateur
  const userLogs = logs.filter(l => l.executorId === discordId);

  res.json({
    discordId,
    stats: {
      totalOrdersCreated: userOrders.length,
      totalOrdersHandled: handledOrders.length,
      totalActionsLogged: userLogs.length
    },
    ordersCreated: userOrders,
    ordersHandled: handledOrders,
    actionsLogged: userLogs
  });
});

// ------------------------------------------------------------------
// DÉMARRAGE DU SERVEUR
// ------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur prêt et à l'écoute sur le port ${PORT}`);
});
