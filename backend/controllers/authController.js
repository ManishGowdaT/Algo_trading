const User = require('../models/User');
const Strategy = require('../models/Strategy');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const signToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN
    });
};

const createSendToken = (user, statusCode, res) => {
    const token = signToken(user._id);
    const cookieOptions = {
        expires: new Date(
            Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
        ),
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        path: '/'
    };

    res.cookie('jwt', token, cookieOptions);

    // Remove password from output
    user.password = undefined;

    res.status(statusCode).json({
        status: 'success',
        token,
        data: {
            user
        }
    });
};

exports.login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        // 1) Check if email and password exist
        if (!email || !password) {
            return res.status(400).json({ status: 'fail', message: 'Please provide email and password!' });
        }

        // 2) Check if user exists && password is correct
        const user = await User.findOne({ email }).select('+password');

        if (!user || !(await user.comparePassword(password))) {
            return res.status(401).json({ status: 'fail', message: 'Incorrect email or password' });
        }

        // 3) If everything ok, send token to client
        createSendToken(user, 200, res);
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

exports.register = async (req, res) => {
    const session = await mongoose.startSession();
    try {
        const rawEmail = typeof req.body.email === 'string' ? req.body.email : '';
        const email = rawEmail.trim().toLowerCase();
        const { password, confirmPassword } = req.body;

        if (!email || !password || !confirmPassword) {
            return res.status(400).json({ status: 'fail', message: 'Please provide email, password, and password confirmation.' });
        }
        if (!/^\S+@\S+\.\S+$/.test(email)) {
            return res.status(400).json({ status: 'fail', message: 'Please provide a valid email address.' });
        }
        if (password.length < 8) {
            return res.status(400).json({ status: 'fail', message: 'Password must be at least 8 characters long.' });
        }
        if (password !== confirmPassword) {
            return res.status(400).json({ status: 'fail', message: 'Passwords do not match.' });
        }

        let user;
        await session.withTransaction(async () => {
            const existing = await User.findOne({ email }).session(session).select('_id');
            if (existing) {
                const error = new Error('An account with this email already exists.');
                error.code = 'DUPLICATE_EMAIL';
                throw error;
            }

            const createdUsers = await User.create([{ email, password }], { session });
            user = createdUsers[0];
            await Strategy.insertMany([
                { name: 'HeikenAshi', userId: user._id },
                { name: 'ModifiedHeikenAshi', userId: user._id },
                { name: '5minBreakout', userId: user._id }
            ], { session });
        });

        createSendToken(user, 201, res);
    } catch (err) {
        if (err.code === 'DUPLICATE_EMAIL' || err.code === 11000) {
            return res.status(409).json({ status: 'fail', message: 'An account with this email already exists.' });
        }
        return res.status(500).json({ status: 'error', message: 'Account registration failed.' });
    } finally {
        await session.endSession();
    }
};

exports.logout = (req, res) => {
    res.clearCookie('jwt', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        path: '/'
    });
    res.status(200).json({ status: 'success' });
};

exports.protect = async (req, res, next) => {
    try {
        // 1) Getting token and check of it's there
        let token;
        if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
            token = req.headers.authorization.split(' ')[1];
        } else if (req.cookies && req.cookies.jwt) {
            token = req.cookies.jwt;
        }

        if (!token) {
            return res.status(401).json({ status: 'fail', message: 'You are not logged in! Please log in to get access.' });
        }

        // 2) Verification token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // 3) Check if user still exists
        const currentUser = await User.findById(decoded.id);
        if (!currentUser) {
            return res.status(401).json({ status: 'fail', message: 'The user belonging to this token does no longer exist.' });
        }

        // GRANT ACCESS TO PROTECTED ROUTE
        req.user = currentUser;
        next();
    } catch (err) {
        res.status(401).json({ status: 'fail', message: 'Invalid token or session expired.' });
    }
};

exports.getMe = (req, res) => {
    res.status(200).json({
        status: 'success',
        data: {
            user: req.user
        }
    });
};
