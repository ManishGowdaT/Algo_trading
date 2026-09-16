const Trade = require('../models/Trade');
const Strategy = require('../models/Strategy');

exports.recordTrade = async (req, res) => {
    try {
        const { strategyName, index, premium, qty, buyPrice } = req.body;

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
        res.status(500).json({ status: 'error', message: err.message });
    }
};

exports.updateTradeExit = async (req, res) => {
    try {
        const { tradeId, exitPrice, exitReason } = req.body;

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
        res.status(500).json({ status: 'error', message: err.message });
    }
};

exports.getLatestOpenTrade = async (req, res) => {
    try {
        const { strategyName } = req.query;
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
        res.status(500).json({ status: 'error', message: err.message });
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
        res.status(500).json({ status: 'error', message: err.message });
    }
};
exports.getAllTrades = async (req, res) => {
    try {
        const { strategyId, startDate, endDate, page = 1, limit = 10, searchQuery, exitReason, timeFrom, timeTo } = req.query;
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

        const timeFromMinutes = parseTimeToMinutes(timeFrom);
        const timeToMinutes = parseTimeToMinutes(timeTo);

        if (timeFrom && timeFromMinutes === null) {
            return res.status(400).json({ status: 'fail', message: 'Invalid timeFrom. Expected HH:mm' });
        }
        if (timeTo && timeToMinutes === null) {
            return res.status(400).json({ status: 'fail', message: 'Invalid timeTo. Expected HH:mm' });
        }
        if (timeFromMinutes !== null && timeToMinutes !== null && timeFromMinutes > timeToMinutes) {
            return res.status(400).json({ status: 'fail', message: 'Invalid time range. timeFrom must be less than or equal to timeTo' });
        }

        if (strategyId) {
            const mongoose = require('mongoose');
            query.strategyId = new mongoose.Types.ObjectId(strategyId);
        }

        if (searchQuery) {
            query.$or = [
                { index: { $regex: searchQuery, $options: "i" } },
                { premium: { $regex: searchQuery, $options: "i" } }
            ];

            if (!isNaN(searchQuery)) {
                query.$or.push({ premium: Number(searchQuery) });
            }
        }

        if (exitReason) {
            query.exitReason = { $regex: new RegExp(`^${exitReason}$`, 'i') };
        }

        if (startDate || endDate) {
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

        console.log("Trades Query Built:", JSON.stringify(query, null, 2));

        const trades = await Trade.find(query)
            .populate('strategyId', 'name')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

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
        res.status(500).json({ status: 'error', message: err.message });
    }
};
