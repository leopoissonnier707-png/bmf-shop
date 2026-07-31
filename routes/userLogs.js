const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Log = require('../models/Log');
const { checkNotBanned, requirePermission } = require('../middlewares/auth');
const { PERMISSIONS } = require('../config/permissions');

router.get('/user-activity/:discordId', checkNotBanned, requirePermission(PERMISSIONS.VIEW_USER_LOGS), async (req, res) => {
  const { discordId } = req.params;

  try {
    // 1. Commandes passées par l'utilisateur
    const ordersCreated = await Order.find({ userId: discordId }).sort({ createdAt: -1 });

    // 2. Commandes traitées/acceptées par l'utilisateur (s'il est staff)
    const ordersHandled = await Order.find({ staffId: discordId }).sort({ updatedAt: -1 });

    // 3. System logs/actions effectués sur la plateforme
    const userLogs = await Log.find({ executorId: discordId }).sort({ timestamp: -1 });

    res.json({
      discordId,
      summary: {
        totalOrdersCreated: ordersCreated.length,
        totalOrdersHandled: ordersHandled.length,
        totalActionsLogged: userLogs.length
      },
      ordersCreated,
      ordersHandled,
      logs: userLogs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
