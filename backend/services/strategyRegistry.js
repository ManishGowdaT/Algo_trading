const fs = require('fs');
const path = require('path');
const BaseStrategy = require('../trading/strategies/BaseStrategy');
const StrategyModel = require('../models/Strategy');
const User = require('../models/User');

const ENGINE_VERSION = '1.0.0';
const PLUGINS_DIR = path.join(__dirname, '../trading/strategies/plugins');

class StrategyRegistry {
  constructor() {
    this.plugins = new Map(); // strategyId -> PluginClass
    this.isLoaded = false;
  }

  /**
   * Initializes startup-only plugin discovery.
   */
  async init() {
    if (this.isLoaded) return;
    console.log('[StrategyRegistry] Initializing startup strategy plugin discovery...');
    this.discoverPlugins();
    await this.syncDatabaseRecords();
    this.isLoaded = true;
  }

  /**
   * Synchronously scans plugins folder at startup.
   */
  discoverPlugins() {
    this.plugins.clear();

    if (!fs.existsSync(PLUGINS_DIR)) {
      console.warn(`[StrategyRegistry] Plugins directory missing at ${PLUGINS_DIR}`);
      return;
    }

    const files = fs.readdirSync(PLUGINS_DIR);

    for (const file of files) {
      if (!file.endsWith('.js') && !file.endsWith('.ts')) continue;

      const filePath = path.join(PLUGINS_DIR, file);
      try {
        const PluginClass = require(filePath);

        if (!PluginClass || !PluginClass.manifest) {
          console.warn(`[StrategyRegistry] Skipping ${file}: Missing static manifest`);
          continue;
        }

        BaseStrategy.validateManifest(PluginClass.manifest);

        if (PluginClass.manifest.engineVersion !== ENGINE_VERSION) {
          console.warn(`[StrategyRegistry] Skipping ${file}: Incompatible engineVersion "${PluginClass.manifest.engineVersion}" (Required: ${ENGINE_VERSION})`);
          continue;
        }

        const strategyId = PluginClass.manifest.id;
        this.plugins.set(strategyId, PluginClass);
        console.log(`[StrategyRegistry] Registered Strategy Plugin: ${PluginClass.manifest.name} (id: ${strategyId}, engineVersion: ${PluginClass.manifest.engineVersion})`);

      } catch (err) {
        console.error(`[StrategyRegistry] Failed to load strategy plugin ${file}:`, err.message);
      }
    }

    console.log(`[StrategyRegistry] Successfully loaded ${this.plugins.size} strategy plugins.`);
  }

  /**
   * Auto-syncs discovered strategy entries to MongoDB.
   */
  async syncDatabaseRecords() {
    try {
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState !== 1) return;

      const users = await User.find({}, { _id: 1 }).lean();
      if (users.length === 0) return;

      for (const user of users) {
        for (const [id, PluginClass] of this.plugins.entries()) {
          const existing = await StrategyModel.findOne({ name: id, userId: user._id });
          if (!existing) {
            await StrategyModel.create({
              name: id,
              userId: user._id
            });
            console.log(`[StrategyRegistry] Auto-seeded MongoDB Strategy record for "${id}" for user ${user._id}`);
          }
        }
      }
    } catch (err) {
      console.warn('[StrategyRegistry] MongoDB sync warning:', err.message);
    }
  }

  /**
   * Retrieves registered plugin class by id.
   */
  getPlugin(id) {
    return this.plugins.get(id) || null;
  }

  /**
   * Checks if plugin id is registered.
   */
  hasPlugin(id) {
    return this.plugins.has(id);
  }

  /**
   * Returns array of all registered plugin manifests for UI auto-rendering.
   */
  getManifests() {
    const manifests = [];
    for (const [id, PluginClass] of this.plugins.entries()) {
      manifests.push(PluginClass.manifest);
    }
    return manifests;
  }
}

module.exports = new StrategyRegistry();
