const Trade = require('../models/Trade');
const Strategy = require('../models/Strategy');
const mongoose = require('mongoose');
const {
    escapeRegexLiteral,
    InputValidationError,
    isIsoDate,
    parseBoundedInteger,
} = require('../utils/inputValidation');
const { respondWithApiError } = require('../middleware/apiErrors');

function requireText(value, name, maxLength) {
    if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
        throw new InputValidationError(`${name} must be a non-empty string of at most ${maxLength} characters.`);
    }
    return value;
}

function requireFiniteNumber(value, name, { integer = false, min = 0, max = 1_000_000_000 } = {}) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        throw new InputValidationError(`${name} must be a ${integer ? 'whole' : 'finite'} number between ${min} and ${max}.`);
    }
    return value;
}

function requireQueryString(value, name, maxLength) {
    if (value === undefined) return undefined;
    if (value === '') return value;
    if (typeof value !== 'string' || value.length > maxLength) {
        throw new InputValidationError(`${name} must be at most ${maxLength} characters.`);
    }
    return requireText(value, name, maxLength);
}

function sendFailure(req, res, err) {
    return respondWithApiError(req, res, err);
}

exports.recordTrade = async (req, res) => {
    try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
            throw new InputValidationError('Trade request must be a JSON object.');
        }
        const { strategyName, index, premium, qty, buyPrice } = req.body;
        requireText(strategyName, 'strategyName', 64);
        requireText(index, 'index', 32);
        requireText(premium, 'premium', 64);
        requireFiniteNumber(qty, 'qty', { integer: true, min: 1, max: 1_000_000 });
        requireFiniteNumber(buyPrice, 'buyPrice', { min: 0.01 });

        // 1. Find strategy
        const strategy = await Strategy.findOne({ name: strategyName, userId: req.user._id });
        if (!strategy) {
            return res.status(404).json({ status: 'fail', message: 'Strategy not found' });
        }

        // 2. Create trade log
        const trade = await Trade.create({
            userId: req.user._id,
            strategyId: strategy._id,
            index,
            premium,
            qty,
            buyPrice
        });

        res.status(201).json({
            status: 'success',
            data: {
                trade
            }
        });
    } catch (err) {
        sendFailure(req, res, err);
    }
};

exports.updateTradeExit = async (req, res) => {
    try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
            throw new InputValidationError('Trade exit request must be a JSON object.');
        }
        const { tradeId, exitPrice, exitReason } = req.body;
        if (typeof tradeId !== 'string' || !mongoose.isValidObjectId(tradeId)) {
            throw new InputValidationError('tradeId must be a valid trade id.');
        }
        requireFiniteNumber(exitPrice, 'exitPrice', { min: 0.01 });
        const allowedExitReasons = Trade.schema.path('exitReason').enumValues;
        if (typeof exitReason !== 'string' || !allowedExitReasons.includes(exitReason)) {
            throw new InputValidationError('exitReason is not supported.');
        }

        const trade = await Trade.findOne({ _id: tradeId, userId: req.user._id });
        if (!trade) {
            return res.status(404).json({ status: 'fail', message: 'Trade not found' });
        }

        // Calculate PNL
        const pnl = (exitPrice - trade.buyPrice) * trade.qty;

        trade.exitPrice = exitPrice;
        trade.exitReason = exitReason;
        trade.pnl = pnl;

        await trade.save();

        res.status(200).json({
            status: 'success',
            data: {
                trade
            }
        });
    } catch (err) {
        sendFailure(req, res, err);
    }
};

exports.getLatestOpenTrade = async (req, res) => {
    try {
        const { strategyName } = req.query;
        requireText(strategyName, 'strategyName', 64);
        const strategy = await Strategy.findOne({ name: strategyName, userId: req.user._id });

        if (!strategy) {
            return res.status(404).json({ status: 'fail', message: 'Strategy not found' });
        }

        const trade = await Trade.findOne({
            userId: req.user._id,
            strategyId: strategy._id,
            exitPrice: { $exists: false }
        }).sort({ createdAt: -1 });

        res.status(200).json({
            status: 'success',
            data: {
                trade
            }
        });
    } catch (err) {
        sendFailure(req, res, err);
    }
};
exports.getStats = async (req, res) => {
    try {
        const stats = await Trade.aggregate([
            { $match: { userId: req.user._id, pnl: { $exists: true } } },
            {
                $group: {
                    _id: null,
                    totalPnl: { $sum: '$pnl' },
                    totalTrades: { $sum: 1 },
                    winningTrades: {
                        $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] }
                    }
                }
            }
        ]);

        const data = stats.length > 0 ? stats[0] : { totalPnl: 0, totalTrades: 0, winningTrades: 0 };
        const winRate = data.totalTrades > 0 ? (data.winningTrades / data.totalTrades) * 100 : 0;

        res.status(200).json({
            status: 'success',
            data: {
                totalPnl: data.totalPnl,
                totalTrades: data.totalTrades,
                winRate: Math.round(winRate)
            }
        });
    } catch (err) {
        respondWithApiError(req, res, err);
    }
};
exports.getAllTrades = async (req, res) => {
    try {
        const { strategyId, startDate, endDate, page: rawPage, limit: rawLimit, searchQuery, exitReason, timeFrom, timeTo } = req.query;
        const page = parseBoundedInteger(rawPage, { name: 'page', defaultValue: 1, min: 1, max: 10_000 });
        const limit = parseBoundedInteger(rawLimit, { name: 'limit', defaultValue: 10, min: 1, max: 100 });
        requireQueryString(strategyId, 'strategyId', 24);
        requireQueryString(startDate, 'startDate', 10);
        requireQueryString(endDate, 'endDate', 10);
        const safeSearchQuery = requireQueryString(searchQuery, 'searchQuery', 100);
        const safeExitReason = requireQueryString(exitReason, 'exitReason', 64);
        const safeTimeFrom = requireQueryString(timeFrom, 'timeFrom', 5);
        const safeTimeTo = requireQueryString(timeTo, 'timeTo', 5);
        const query = { userId: req.user._id };

        const parseTimeToMinutes = (value) => {
            if (typeof value !== 'string' || value.trim() === '') return null;
            const match = value.match(/^(\d{2}):(\d{2})$/);
            if (!match) return null;
            const hours = Number(match[1]);
            const minutes = Number(match[2]);
            if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
            if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
            return hours * 60 + minutes;
        };

        const timeFromMinutes = parseTimeToMinutes(safeTimeFrom);
        const timeToMinutes = parseTimeToMinutes(safeTimeTo);

        if (safeTimeFrom && timeFromMinutes === null) {
            return res.status(400).json({ status: 'fail', message: 'Invalid timeFrom. Expected HH:mm' });
        }
        if (safeTimeTo && timeToMinutes === null) {
            return res.status(400).json({ status: 'fail', message: 'Invalid timeTo. Expected HH:mm' });
        }
        if (timeFromMinutes !== null && timeToMinutes !== null && timeFromMinutes > timeToMinutes) {
            return res.status(400).json({ status: 'fail', message: 'Invalid time range. timeFrom must be less than or equal to timeTo' });
        }

        if (strategyId) {
            if (!mongoose.isValidObjectId(strategyId)) {
                throw new InputValidationError('strategyId must be a valid strategy id.');
            }
            query.strategyId = new mongoose.Types.ObjectId(strategyId);
        }

        if (safeSearchQuery) {
            const literalSearch = escapeRegexLiteral(safeSearchQuery);
            query.$or = [
                { index: { $regex: literalSearch, $options: 'i' } },
                { premium: { $regex: literalSearch, $options: 'i' } }
            ];

            const numericSearch = Number(safeSearchQuery);
            if (safeSearchQuery.trim() !== '' && Number.isFinite(numericSearch)) {
                query.$or.push({ premium: numericSearch });
            }
        }

        if (safeExitReason) {
            const allowedExitReasons = Trade.schema.path('exitReason').enumValues;
            const matchedReason = allowedExitReasons.find((reason) => reason.toLowerCase() === safeExitReason.toLowerCase());
            if (!matchedReason) throw new InputValidationError('exitReason is not supported.');
            query.exitReason = matchedReason;
        }

        if (startDate || endDate) {
            if (startDate && !isIsoDate(startDate)) throw new InputValidationError('startDate must use YYYY-MM-DD format.');
            if (endDate && !isIsoDate(endDate)) throw new InputValidationError('endDate must use YYYY-MM-DD format.');
            if (startDate && endDate && startDate > endDate) throw new InputValidationError('startDate must not be after endDate.');
            query.createdAt = {};
            if (startDate) query.createdAt.$gte = new Date(`${startDate}T00:00:00.000+05:30`);
            if (endDate) query.createdAt.$lte = new Date(`${endDate}T23:59:59.999+05:30`);
        }

        if (timeFromMinutes !== null || timeToMinutes !== null) {
            const istMinutesExpr = {
                $let: {
                    vars: {
                        parts: {
                            $dateToParts: {
                                date: '$createdAt',
                                timezone: 'Asia/Kolkata'
                            }
                        }
                    },
                    in: {
                        $add: [
                            { $multiply: ['$$parts.hour', 60] },
                            '$$parts.minute'
                        ]
                    }
                }
            };

            const exprConditions = [];
            if (timeFromMinutes !== null) exprConditions.push({ $gte: [istMinutesExpr, timeFromMinutes] });
            if (timeToMinutes !== null) exprConditions.push({ $lte: [istMinutesExpr, timeToMinutes] });
            query.$expr = { $and: exprConditions };
        }

        const trades = await Trade.find(query)
            .populate('strategyId', 'name')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit);

        // Calculate analytics based on the SAME query used for filtering
        const analytics = await Trade.aggregate([
            { $match: query },
            {
                $group: {
                    _id: null,
                    totalPnl: { $sum: '$pnl' },
                    totalTrades: { $sum: 1 }
                }
            }
        ]);

        let stats = {
            totalPnl: 0,
            totalTrades: 0,
            taxes: 0,
            netPnl: 0
        };

        if (analytics.length > 0) {
            const totalPnl = analytics[0].totalPnl || 0;
            // Assuming tax calculation is around Rs. 60 per trade (Brokerage + STT + other charges for options usually averages out here for small quantities)
            // Or we could use a flat percentage. Let's use a standard Rs. 50 per executed trade (buy+sell) as an approximation 
            // since actual taxes aren't stored in the DB row.
            const estimatedTaxes = analytics[0].totalTrades * 60;

            stats = {
                totalPnl: totalPnl,
                totalTrades: analytics[0].totalTrades,
                taxes: estimatedTaxes,
                netPnl: totalPnl - estimatedTaxes
            };
        }

        const total = await Trade.countDocuments(query);

        res.status(200).json({
            status: 'success',
            results: trades.length,
            total,
            pages: Math.ceil(total / limit),
            analytics: stats,
            data: {
                trades
            }
        });
    } catch (err) {
        sendFailure(req, res, err);
    }
};
