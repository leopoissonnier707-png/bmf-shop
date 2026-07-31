const express = require('express');
const router = express.Router();
const CatalogItem = require('../models/CatalogItem');
const { checkNotBanned, requirePermission } = require('../middlewares/auth');
const { PERMISSIONS } = require('../config/permissions');

// Route de suppression avec vérification de nom exact
router.delete('/delete-item', checkNotBanned, requirePermission(PERMISSIONS.DELETE_CATALOG), async (req, res) => {
  const { name, confirmationName } = req.body;

  if (!name || name !== confirmationName) {
    return res.status(400).json({ error: 'Le nom de confirmation ne correspond pas au nom de l’item.' });
  }

  try {
    const item = await CatalogItem.findOneAndDelete({ name: name });
    if (!item) {
      return res.status(404).json({ error: 'Item introuvable dans le catalogue.' });
    }

    res.json({ message: `L'item "${name}" a été supprimé avec succès.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
