/* Telegram Session Manager with Dropbox Sync & Telegram Client */
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Dropbox } = require('dropbox');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Mutex } = require('async-mutex');
const multer = require('multer');
const sharp = require('sharp');

// ==================== CONFIGURATION ====================
const config = {
    webPort: process.env.PORT || 3000,
    webBaseUrl: process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`,
    
    // Dropbox Configuration
    dropboxAppKey: 'ho5ep3i58l3tvgu',
    dropboxAppSecret: '9fy0w0pgaafyk3e',
    dropboxRefreshToken: 'Vjhcbg66GMgAAAAAAAAAARJPgSupFcZdyXFkXiFx7VP-oXv_64RQKmtTLUYfPtm3',
    dropboxSessionsFolder: '/workingtelesessions',
    
    // Telegram API Credentials (for session verification)
    telegramApiId: 33904063,
    telegramApiHash: '51528b792d5be7e300315f7fae356ad9',
    
    // Session Management
    maxClients: 50,
    sessionTimeout: 30000,
    
    // Admin credentials (change these)
    adminUsername: 'admin',
    adminPassword: 'admin123',
    
    // Auto-ping for Render
    autoPingInterval: 4 * 60 * 1000,
};

// ==================== GLOBALS ====================
let dbx = null;
let isDropboxInitialized = false;
const activeClients = new Map(); // sessionId -> { client, userInfo, lastActive }
const clientMutex = new Mutex();
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
                            status: 'inactive'
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

async function uploadSessionToDropbox(sessionString, fileName) {
    if (!isDropboxInitialized || !dbx) {
        await initializeDropbox();
        if (!dbx) return false;
    }
    
    try {
        const dropboxPath = `${config.dropboxSessionsFolder}/${fileName}`;
        
        await dbx.filesUpload({
            path: dropboxPath,
            contents: sessionString,
            mode: { '.tag': 'overwrite' },
            mute: true
        });
        
        console.log(`✅ Uploaded session to Dropbox: ${fileName}`);
        return true;
    } catch (error) {
        console.error('❌ Error uploading to Dropbox:', error.message);
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

// ==================== TELEGRAM CLIENT MANAGEMENT ====================
async function initializeClient(sessionId, sessionString) {
    const release = await clientMutex.acquire();
    
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
                timeout: config.sessionTimeout
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
        
        // Clean up inactive clients periodically
        cleanupInactiveClients();
        
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
    } finally {
        release();
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
    const release = await clientMutex.acquire();
    
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
    } finally {
        release();
    }
}

async function disconnectAllClients() {
    const release = await clientMutex.acquire();
    
    try {
        for (const [sessionId, clientData] of activeClients.entries()) {
            try {
                await clientData.client.disconnect();
            } catch (e) {
                // Ignore disconnect errors
            }
            activeClients.delete(sessionId);
        }
        
        console.log('🔌 Disconnected all clients');
        return true;
    } catch (error) {
        console.error('❌ Error disconnecting all clients:', error.message);
        return false;
    } finally {
        release();
    }
}

// ==================== TELEGRAM OPERATIONS ====================
async function getGroups(sessionId) {
    try {
        const db = readDatabase();
        const session = db.sessions.find(s => s.id === sessionId);
        if (!session) {
            throw new Error('Session not found');
        }
        
        const client = await initializeClient(sessionId, session.sessionString);
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
        if (!db.groups[sessionId]) {
            db.groups[sessionId] = [];
        }
        db.groups[sessionId] = groups;
        writeDatabase(db);
        
        return groups;
    } catch (error) {
        console.error(`❌ Error getting groups for ${sessionId}:`, error.message);
        throw error;
    }
}

async function sendMessage(sessionId, peer, message, mediaPath = null) {
    try {
        const db = readDatabase();
        const session = db.sessions.find(s => s.id === sessionId);
        if (!session) {
            throw new Error('Session not found');
        }
        
        const client = await initializeClient(sessionId, session.sessionString);
        
        let result;
        if (mediaPath) {
            // Send media with caption
            result = await client.sendFile(peer, {
                file: mediaPath,
                caption: message,
                forceDocument: false
            });
        } else {
            // Send text message
            result = await client.sendMessage(peer, { message });
        }
        
        // Log message in database
        db.messages.push({
            id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            sessionId: sessionId,
            peer: peer,
            message: message,
            media: mediaPath,
            timestamp: new Date().toISOString(),
            messageId: result.id.toString()
        });
        
        db.stats.totalMessagesSent++;
        writeDatabase(db);
        
        return {
            success: true,
            messageId: result.id,
            date: result.date
        };
    } catch (error) {
        console.error(`❌ Error sending message from ${sessionId}:`, error.message);
        throw error;
    }
}

async function addUserToGroup(sessionId, groupId, userId) {
    try {
        const db = readDatabase();
        const session = db.sessions.find(s => s.id === sessionId);
        if (!session) {
            throw new Error('Session not found');
        }
        
        const client = await initializeClient(sessionId, session.sessionString);
        
        // Import InputUser
        const { Api } = require('telegram');
        
        // Create InputPeerUser
        const inputUser = new Api.InputPeerUser({
            userId: BigInt(userId),
            accessHash: 0n // You'll need the actual access hash for this
        });
        
        // Add user to group
        await client.invoke(
            new Api.channels.InviteToChannel({
                channel: groupId,
                users: [inputUser]
            })
        );
        
        return { success: true };
    } catch (error) {
        console.error(`❌ Error adding user to group:`, error.message);
        throw error;
    }
}

async function forwardToAllGroups(sessionId, message, sourceMessageId = null) {
    try {
        const groups = await getGroups(sessionId);
        const results = [];
        
        for (const group of groups) {
            try {
                let result;
                if (sourceMessageId) {
                    // Forward existing message
                    const client = await initializeClient(sessionId, session.sessionString);
                    result = await client.forwardMessages(group.id, {
                        messages: [parseInt(sourceMessageId)],
                        fromPeer: 'me'
                    });
                } else {
                    // Send new message
                    result = await sendMessage(sessionId, group.id, message);
                }
                
                results.push({
                    group: group.title,
                    success: true,
                    result: result
                });
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                results.push({
                    group: group.title,
                    success: false,
                    error: error.message
                });
            }
        }
        
        // Log forwarding in database
        const db = readDatabase();
        db.forwardedMessages.push({
            id: `fwd_${Date.now()}`,
            sessionId: sessionId,
            message: message,
            sourceMessageId: sourceMessageId,
            results: results,
            timestamp: new Date().toISOString(),
            totalGroups: groups.length,
            successful: results.filter(r => r.success).length
        });
        writeDatabase(db);
        
        return results;
    } catch (error) {
        console.error(`❌ Error forwarding to all groups:`, error.message);
        throw error;
    }
}

async function getSessionInfo(sessionId) {
    try {
        const db = readDatabase();
        const session = db.sessions.find(s => s.id === sessionId);
        if (!session) {
            throw new Error('Session not found');
        }
        
        const client = await initializeClient(sessionId, session.sessionString);
        const user = await client.getMe();
        
        // Get some stats
        const dialogs = await client.getDialogs({ limit: 10 });
        
        return {
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
            clientStatus: activeClients.has(sessionId) ? 'connected' : 'disconnected',
            lastActive: activeClients.get(sessionId)?.lastActive || null
        };
    } catch (error) {
        console.error(`❌ Error getting session info:`, error.message);
        throw error;
    }
}

// ==================== EXPRESS SERVER ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
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

// Create public directory with HTML files
if (!fs.existsSync('public')) {
    fs.mkdirSync('public', { recursive: true });
    
    // Create basic HTML interface
    const html = `
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
        </style>
    </head>
    <body>
        <nav class="navbar navbar-dark navbar-expand-lg mb-4">
            <div class="container">
                <a class="navbar-brand" href="/">
                    <i class="bi bi-telegram me-2"></i>
                    Telegram Session Manager
                </a>
                <div class="navbar-nav ms-auto">
                    <a class="nav-link text-white" href="/logout">Logout</a>
                </div>
            </div>
        </nav>
        
        <div class="container" id="app">
            <div class="row">
                <div class="col-md-3">
                    <div class="card mb-4">
                        <div class="card-body">
                            <h5 class="card-title">
                                <i class="bi bi-cloud-arrow-up me-2"></i>
                                Upload Session
                            </h5>
                            <form id="uploadForm" enctype="multipart/form-data">
                                <div class="mb-3">
                                    <input type="file" class="form-control" id="sessionFile" accept=".txt,.session" required>
                                </div>
                                <button type="submit" class="btn btn-primary w-100">
                                    <i class="bi bi-upload me-2"></i>
                                    Upload
                                </button>
                            </form>
                        </div>
                    </div>
                    
                    <div class="card">
                        <div class="card-body">
                            <h5 class="card-title">
                                <i class="bi bi-graph-up me-2"></i>
                                Statistics
                            </h5>
                            <div id="stats"></div>
                        </div>
                    </div>
                </div>
                
                <div class="col-md-9">
                    <div class="card mb-4">
                        <div class="card-body">
                            <div class="d-flex justify-content-between align-items-center mb-3">
                                <h5 class="card-title mb-0">
                                    <i class="bi bi-people me-2"></i>
                                    Active Sessions
                                </h5>
                                <button class="btn btn-sm btn-outline-primary" onclick="loadSessions()">
                                    <i class="bi bi-arrow-clockwise"></i>
                                    Refresh
                                </button>
                            </div>
                            <div id="sessionsList" class="row"></div>
                        </div>
                    </div>
                    
                    <div class="card">
                        <div class="card-body">
                            <h5 class="card-title mb-3">
                                <i class="bi bi-terminal me-2"></i>
                                Session Control Panel
                            </h5>
                            <div id="controlPanel"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
        <script>
            async function loadSessions() {
                try {
                    const response = await fetch('/api/sessions');
                    const sessions = await response.json();
                    
                    const container = document.getElementById('sessionsList');
                    container.innerHTML = '';
                    
                    sessions.forEach(session => {
                        const badgeClass = session.status === 'active' ? 'badge-online' : 
                                         session.status === 'error' ? 'badge-error' : 'badge-offline';
                        
                        const card = \`
                        <div class="col-md-6 col-lg-4 mb-3">
                            <div class="card session-card h-100">
                                <div class="card-body">
                                    <div class="d-flex justify-content-between align-items-start mb-2">
                                        <h6 class="card-title mb-0">
                                            <i class="bi bi-person-circle me-2"></i>
                                            \${session.firstName || 'User'}
                                        </h6>
                                        <span class="badge \${badgeClass}">\${session.status}</span>
                                    </div>
                                    <p class="card-text small mb-1">
                                        <i class="bi bi-telephone me-2"></i>
                                        \${session.phoneNumber || 'No phone'}
                                    </p>
                                    <p class="card-text small mb-1">
                                        <i class="bi bi-at me-2"></i>
                                        \${session.username || 'No username'}
                                    </p>
                                    <p class="card-text small mb-3 text-muted">
                                        <i class="bi bi-calendar me-2"></i>
                                        Added: \${new Date(session.addedAt).toLocaleDateString()}
                                    </p>
                                    <div class="d-grid gap-2">
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
                }
            }
            
            async function openSessionControl(sessionId) {
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/info\`);
                    const info = await response.json();
                    
                    const panel = document.getElementById('controlPanel');
                    panel.innerHTML = \`
                    <div class="row">
                        <div class="col-md-4">
                            <div class="card mb-3">
                                <div class="card-body">
                                    <h6 class="card-title">Session Info</h6>
                                    <ul class="list-group list-group-flush">
                                        <li class="list-group-item d-flex justify-content-between">
                                            <span>Phone:</span>
                                            <strong>\${info.user.phone || 'N/A'}</strong>
                                        </li>
                                        <li class="list-group-item d-flex justify-content-between">
                                            <span>Username:</span>
                                            <strong>@\${info.user.username || 'N/A'}</strong>
                                        </li>
                                        <li class="list-group-item d-flex justify-content-between">
                                            <span>Status:</span>
                                            <strong class="text-\${info.clientStatus === 'connected' ? 'success' : 'secondary'}">
                                                \${info.clientStatus}
                                            </strong>
                                        </li>
                                    </ul>
                                </div>
                            </div>
                            
                            <div class="card">
                                <div class="card-body">
                                    <h6 class="card-title">Quick Actions</h6>
                                    <div class="d-grid gap-2">
                                        <button class="btn btn-success" onclick="connectSession('\${sessionId}')">
                                            <i class="bi bi-plug me-1"></i>
                                            Connect
                                        </button>
                                        <button class="btn btn-warning" onclick="disconnectSession('\${sessionId}')">
                                            <i class="bi bi-plug-fill me-1"></i>
                                            Disconnect
                                        </button>
                                        <button class="btn btn-info" onclick="getSessionGroups('\${sessionId}')">
                                            <i class="bi bi-people me-1"></i>
                                            Get Groups
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <div class="col-md-8">
                            <div class="card mb-3">
                                <div class="card-body">
                                    <h6 class="card-title">Send Message</h6>
                                    <form id="sendMessageForm" onsubmit="sendMessage('\${sessionId}'); return false;">
                                        <div class="mb-3">
                                            <label class="form-label">Group/Channel ID</label>
                                            <input type="text" class="form-control" id="peerId_\${sessionId}" placeholder="Enter group ID or @username" required>
                                        </div>
                                        <div class="mb-3">
                                            <label class="form-label">Message</label>
                                            <textarea class="form-control" id="message_\${sessionId}" rows="3" required></textarea>
                                        </div>
                                        <div class="d-grid">
                                            <button type="submit" class="btn btn-primary">
                                                <i class="bi bi-send me-1"></i>
                                                Send Message
                                            </button>
                                        </div>
                                    </form>
                                </div>
                            </div>
                            
                            <div class="card">
                                <div class="card-body">
                                    <h6 class="card-title">Group Management</h6>
                                    <div id="groupsList_\${sessionId}"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    \`;
                } catch (error) {
                    console.error('Error opening session control:', error);
                    alert('Error: ' + error.message);
                }
            }
            
            async function connectSession(sessionId) {
                try {
                    await fetch(\`/api/sessions/\${sessionId}/connect\`, { method: 'POST' });
                    alert('Session connected successfully');
                    loadSessions();
                } catch (error) {
                    alert('Error: ' + error.message);
                }
            }
            
            async function disconnectSession(sessionId) {
                try {
                    await fetch(\`/api/sessions/\${sessionId}/disconnect\`, { method: 'POST' });
                    alert('Session disconnected');
                    loadSessions();
                } catch (error) {
                    alert('Error: ' + error.message);
                }
            }
            
            async function getSessionGroups(sessionId) {
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/groups\`);
                    const groups = await response.json();
                    
                    const container = document.getElementById(\`groupsList_\${sessionId}\`);
                    let html = '<div class="table-responsive"><table class="table table-sm"><thead><tr><th>Title</th><th>Type</th><th>Members</th><th>Actions</th></tr></thead><tbody>';
                    
                    groups.forEach(group => {
                        html += \`
                        <tr>
                            <td>\${group.title}</td>
                            <td><span class="badge \${group.isChannel ? 'bg-info' : 'bg-success'}">\${group.isChannel ? 'Channel' : 'Group'}</span></td>
                            <td>\${group.participantsCount || 'N/A'}</td>
                            <td>
                                <button class="btn btn-sm btn-outline-primary" onclick="sendToGroup('\${sessionId}', '\${group.id}')">
                                    <i class="bi bi-send"></i>
                                </button>
                            </td>
                        </tr>
                        \`;
                    });
                    
                    html += '</tbody></table></div>';
                    container.innerHTML = html;
                } catch (error) {
                    alert('Error getting groups: ' + error.message);
                }
            }
            
            async function sendMessage(sessionId) {
                const peer = document.getElementById(\`peerId_\${sessionId}\`).value;
                const message = document.getElementById(\`message_\${sessionId}\`).value;
                
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/send\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ peer, message })
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        alert('Message sent successfully!');
                    } else {
                        alert('Error: ' + result.error);
                    }
                } catch (error) {
                    alert('Error: ' + error.message);
                }
            }
            
            async function sendToGroup(sessionId, groupId) {
                const message = prompt('Enter message to send:');
                if (!message) return;
                
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/send\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ peer: groupId, message })
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        alert('Message sent to group!');
                    } else {
                        alert('Error: ' + result.error);
                    }
                } catch (error) {
                    alert('Error: ' + error.message);
                }
            }
            
            async function deleteSession(sessionId) {
                if (confirm('Are you sure you want to delete this session?')) {
                    try {
                        await fetch(\`/api/sessions/\${sessionId}\`, { method: 'DELETE' });
                        loadSessions();
                    } catch (error) {
                        alert('Error: ' + error.message);
                    }
                }
            }
            
            // Handle session upload
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
                        alert('Session uploaded successfully!');
                        fileInput.value = '';
                        loadSessions();
                    } else {
                        alert('Error: ' + result.error);
                    }
                } catch (error) {
                    alert('Error uploading: ' + error.message);
                }
            });
            
            // Load sessions on page load
            document.addEventListener('DOMContentLoaded', loadSessions);
            
            // Load stats
            async function loadStats() {
                try {
                    const response = await fetch('/api/stats');
                    const stats = await response.json();
                    document.getElementById('stats').innerHTML = \`
                        <p class="mb-1">Sessions: <strong>\${stats.totalSessions}</strong></p>
                        <p class="mb-1">Messages Sent: <strong>\${stats.totalMessagesSent}</strong></p>
                        <p class="mb-1">Connected: <strong>\${stats.connectedClients}</strong></p>
                        <p class="mb-0 text-muted small">Last Sync: \${new Date(stats.lastSync).toLocaleString()}</p>
                    \`;
                } catch (error) {
                    console.error('Error loading stats:', error);
                }
            }
            loadStats();
        </script>
    </body>
    </html>
    `;
    
    fs.writeFileSync('public/index.html', html);
}

// ==================== AUTHENTICATION ROUTES ====================
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

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ==================== API ROUTES ====================
// Upload session file
app.post('/api/sessions/upload', requireAuth, async (req, res) => {
    try {
        if (!req.files || !req.files.session) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }
        
        const sessionFile = req.files.session;
        const sessionString = sessionFile.data.toString();
        const fileName = `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.txt`;
        
        // Test the session
        let userInfo;
        try {
            const client = new TelegramClient(
                new StringSession(sessionString),
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
            return res.status(400).json({ 
                success: false, 
                error: `Invalid session file: ${error.message}` 
            });
        }
        
        // Save locally
        const localPath = path.join(SESSIONS_FOLDER, fileName);
        fs.writeFileSync(localPath, sessionString);
        
        // Upload to Dropbox
        await uploadSessionToDropbox(sessionString, fileName);
        
        // Add to database
        const db = readDatabase();
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        db.sessions.push({
            id: sessionId,
            fileName: fileName,
            phoneNumber: userInfo.phone,
            userId: userInfo.userId,
            username: userInfo.username,
            firstName: userInfo.firstName,
            lastName: userInfo.lastName,
            isBot: userInfo.isBot,
            sessionString: sessionString,
            addedAt: new Date().toISOString(),
            lastUsed: null,
            isValid: true,
            status: 'inactive'
        });
        
        db.stats.totalSessions = db.sessions.length;
        db.stats.lastSync = new Date().toISOString();
        writeDatabase(db);
        
        res.json({
            success: true,
            message: 'Session uploaded and verified successfully',
            sessionId: sessionId,
            user: userInfo
        });
    } catch (error) {
        console.error('Error uploading session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

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
        const sessionInfo = await getSessionInfo(req.params.sessionId);
        res.json(sessionInfo);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Connect to session
app.post('/api/sessions/:sessionId/connect', requireAuth, async (req, res) => {
    try {
        const db = readDatabase();
        const session = db.sessions.find(s => s.id === req.params.sessionId);
        
        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }
        
        await initializeClient(session.id, session.sessionString);
        res.json({ success: true, message: 'Session connected' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Disconnect from session
app.post('/api/sessions/:sessionId/disconnect', requireAuth, async (req, res) => {
    try {
        await disconnectClient(req.params.sessionId);
        res.json({ success: true, message: 'Session disconnected' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get session groups
app.get('/api/sessions/:sessionId/groups', requireAuth, async (req, res) => {
    try {
        const groups = await getGroups(req.params.sessionId);
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
        
        const result = await sendMessage(req.params.sessionId, peer, message);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Forward to all groups
app.post('/api/sessions/:sessionId/forward', requireAuth, async (req, res) => {
    try {
        const { message, sourceMessageId } = req.body;
        
        if (!message && !sourceMessageId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Either message or sourceMessageId is required' 
            });
        }
        
        const results = await forwardToAllGroups(req.params.sessionId, message, sourceMessageId);
        res.json({ success: true, results: results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Add user to group
app.post('/api/sessions/:sessionId/add-user', requireAuth, async (req, res) => {
    try {
        const { groupId, userId } = req.body;
        
        if (!groupId || !userId) {
            return res.status(400).json({ 
                success: false, 
                error: 'groupId and userId are required' 
            });
        }
        
        const result = await addUserToGroup(req.params.sessionId, groupId, userId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete session
app.delete('/api/sessions/:sessionId', requireAuth, async (req, res) => {
    try {
        const db = readDatabase();
        const sessionIndex = db.sessions.findIndex(s => s.id === req.params.sessionId);
        
        if (sessionIndex === -1) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }
        
        const session = db.sessions[sessionIndex];
        
        // Disconnect client if active
        await disconnectClient(req.params.sessionId);
        
        // Remove local file
        const filePath = path.join(SESSIONS_FOLDER, session.fileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        
        // Remove from database
        db.sessions.splice(sessionIndex, 1);
        db.stats.totalSessions = db.sessions.length;
        writeDatabase(db);
        
        // Try to remove from Dropbox
        try {
            if (dbx) {
                await dbx.filesDeleteV2({ 
                    path: `${config.dropboxSessionsFolder}/${session.fileName}` 
                });
            }
        } catch (dropboxError) {
            console.warn('Could not delete from Dropbox:', dropboxError.message);
        }
        
        res.json({ success: true, message: 'Session deleted' });
    } catch (error) {
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
        activeSessions: db.sessions.filter(s => s.status === 'active').length
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

// Ping endpoint for Render
app.get('/ping', (req, res) => {
    res.json({ 
        status: 'online',
        timestamp: new Date().toISOString(),
        activeClients: activeClients.size,
        totalSessions: readDatabase().sessions.length
    });
});

// ==================== INITIALIZE SERVER ====================
async function startServer() {
    try {
        // Initialize Dropbox
        await initializeDropbox();
        
        // Start cleanup interval
        setInterval(cleanupInactiveClients, 60 * 1000); // Every minute
        
        // Auto-ping for Render
        if (config.autoPingInterval > 0) {
            setInterval(async () => {
                try {
                    await axios.get(`${config.webBaseUrl}/ping`, { timeout: 10000 });
                    console.log('✅ Auto-ping successful');
                } catch (error) {
                    console.warn('⚠️ Auto-ping failed:', error.message);
                }
            }, config.autoPingInterval);
        }
        
        const server = app.listen(config.webPort, '0.0.0.0', () => {
            console.log(`🚀 Telegram Session Manager running on port ${config.webPort}`);
            console.log(`🌐 Web interface: ${config.webBaseUrl}`);
            console.log(`🔐 Admin login: ${config.adminUsername} / ${config.adminPassword}`);
            console.log(`☁️ Dropbox sync: ${isDropboxInitialized ? '✅ Connected' : '❌ Disconnected'}`);
            console.log(`📁 Sessions folder: ${config.dropboxSessionsFolder}`);
        });
        
        return server;
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🚨 Shutting down...');
    
    await disconnectAllClients();
    
    // Sync database to Dropbox
    await syncDatabaseToDropbox();
    
    console.log('✅ Shutdown complete');
    process.exit(0);
});

// Start the server
startServer();
