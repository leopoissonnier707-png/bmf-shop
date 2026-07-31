const express = require('express');
const router = express.Router();
const client = require('../bot');
const RoleConfig = require('../models/RoleConfig'); // Modèle DB stockant { roleId, permissions: [] }
const GUILD_ID = process.env.DISCORD_GUILD_ID;

// 1. Obtenir la liste de tous les rôles avec le nombre de membres et leurs permissions
router.get('/roles', async (req, res) => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.roles.fetch();
    await guild.members.fetch(); // Charger les membres pour la détection
    
    const roleConfigs = await RoleConfig.find();
    const configMap = new Map(roleConfigs.map(c => [c.roleId, c.permissions]));

    const rolesData = guild.roles.cache.map(role => {
      const membersWithRole = role.members.map(m => ({
        id: m.id,
        username: m.user.username,
        displayName: m.displayName,
        avatar: m.user.displayAvatarURL()
      }));

      return {
        id: role.id,
        name: role.name,
        color: role.hexColor,
        memberCount: membersWithRole.length,
        members: membersWithRole,
        permissions: configMap.get(role.id) || []
      };
    });

    res.json(rolesData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Mettre à jour les permissions d'un rôle
router.put('/roles/:roleId/permissions', async (req, res) => {
  const { roleId } = req.params;
  const { permissions } = req.body; // Tableau de clés (ex: ['access_panel', 'manage_orders'])

  try {
    const updated = await RoleConfig.findOneAndUpdate(
      { roleId },
      { roleId, permissions },
      { upsert: true, new: true }
    );
    res.json({ message: 'Permissions mises à jour', config: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
