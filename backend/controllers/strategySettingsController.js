const settingsService = require('../services/strategySettingsService');
const { respondWithApiError } = require('../middleware/apiErrors');

exports.get = async (req, res) => {
  try {
    const settings = await settingsService.get(req.accountContext, req.params.strategyName);
    return res.status(200).json({ status: 'success', data: { config: settings?.config ?? null, version: settings?.version ?? null } });
  } catch (error) { return respondWithApiError(req, res, error); }
};

exports.save = async (req, res) => {
  try {
    const settings = await settingsService.save(req.accountContext, req.params.strategyName, req.body?.config);
    if (!settings) return res.status(404).json({ status: 'fail', message: 'Strategy settings not found.' });
    return res.status(200).json({ status: 'success', data: { config: settings.config, version: settings.version } });
  } catch (error) { return respondWithApiError(req, res, error); }
};
