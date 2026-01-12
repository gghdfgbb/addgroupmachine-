/* Telegram Session Manager with Dropbox Sync & Telegram Client */
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Dropbox } = require('dropbox');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Mutex } = require('async-mutex');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

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

// Initialize database with proper structure
function initializeDatabase() {
    try {
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
                    lastSync: null,
                    validSessions: 0,
                    activeSessions: 0
                }
            };
            fs.writeFileSync(DB_FILE, JSON.stringify(initialDB, null, 2));
            console.log('✅ Database initialized');
        } else {
            // Ensure existing database has all required fields
            const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            let needsUpdate = false;
            
            if (!db.sessions) {
                db.sessions = [];
                needsUpdate = true;
            }
            if (!db.messages) {
                db.messages = [];
                needsUpdate = true;
            }
            if (!db.forwardedMessages) {
                db.forwardedMessages = [];
                needsUpdate = true;
            }
            if (!db.groups) {
                db.groups = {};
                needsUpdate = true;
            }
            if (!db.settings) {
                db.settings = {
                    autoSync: true,
                    maxConcurrentClients: 10
                };
                needsUpdate = true;
            }
            if (!db.stats) {
                db.stats = {
                    totalSessions: db.sessions ? db.sessions.length : 0,
                    totalMessagesSent: 0,
                    lastSync: null,
                    validSessions: 0,
                    activeSessions: 0
                };
                needsUpdate = true;
            }
            
            if (needsUpdate) {
                fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
                console.log('✅ Database structure updated');
            }
        }
    } catch (error) {
        console.error('❌ Database initialization error:', error);
        // Create fresh database on error
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
                lastSync: null,
                validSessions: 0,
                activeSessions: 0
            }
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialDB, null, 2));
    }
}

// Initialize database at startup
initializeDatabase();

function readDatabase() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        const db = JSON.parse(data);
        
        // Ensure all required fields exist
        if (!db.sessions) db.sessions = [];
        if (!db.messages) db.messages = [];
        if (!db.forwardedMessages) db.forwardedMessages = [];
        if (!db.groups) db.groups = {};
        if (!db.settings) db.settings = { autoSync: true, maxConcurrentClients: 10 };
        if (!db.stats) db.stats = { totalSessions: 0, totalMessagesSent: 0, lastSync: null, validSessions: 0, activeSessions: 0 };
        
        return db;
    } catch (error) {
        console.error('Error reading database:', error);
        return {
            sessions: [],
            messages: [],
            forwardedMessages: [],
            groups: {},
            settings: { autoSync: true, maxConcurrentClients: 10 },
            stats: { totalSessions: 0, totalMessagesSent: 0, lastSync: null, validSessions: 0, activeSessions: 0 }
        };
    }
}

function writeDatabase(db) {
    try {
        // Ensure stats are updated
        if (db.sessions) {
            db.stats.totalSessions = db.sessions.length;
            db.stats.validSessions = db.sessions.filter(s => s.isValid).length;
            db.stats.activeSessions = db.sessions.filter(s => s.status === 'active').length;
        }
        
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        syncDatabaseToDropbox();
        return true;
    } catch (error) {
        console.error('Error writing database:', error);
        return false;
    }
}

// Create necessary folders
[UPLOADS_FOLDER, SESSIONS_FOLDER].forEach(folder => {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
    }
});

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
                        
                        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                        
                        db.sessions.push({
                            id: sessionId,
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

// ==================== SESSION STRING VALIDATION ====================
function normalizeSessionString(sessionString) {
    // Remove whitespace, newlines, and trim
    let normalized = sessionString.trim();
    
    // Remove any quotes
    normalized = normalized.replace(/^["']|["']$/g, '');
    
    // Remove "1BAAOMTQ5LjE1NC4xNjcuOTEBu1Ss+xWKwcKta4PzIQkDCDKXwDd4wx3ZePhfT5aWPyJorGNGjiTcw1TGJbckTl05TLU7IyBevgm..." style prefix if present
    // Some session strings might start with version prefix
    if (normalized.includes('...')) {
        normalized = normalized.split('...')[0];
    }
    
    // If string contains dots and looks like encoded, try to decode
    if (normalized.includes('.')) {
        try {
            // Check if it's base64 encoded
            if (!normalized.includes(' ') && normalized.length % 4 === 0) {
                return normalized;
            }
        } catch (e) {
            // Not base64
        }
    }
    
    return normalized;
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
        
        db.stats.totalMessagesSent = (db.stats.totalMessagesSent || 0) + 1;
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
        const db = readDatabase();
        const session = db.sessions.find(s => s.id === sessionId);
        if (!session) {
            throw new Error('Session not found');
        }
        
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
            session: {
                ...session,
                sessionString: undefined // Don't expose full session string
            },
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
            .nav-tabs .nav-link.active { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; }
            .session-string { font-family: monospace; font-size: 0.85rem; background: #f8f9fa; padding: 10px; border-radius: 5px; }
        </style>
    </head>
    <body>
        <nav class="navbar navbar-dark navbar-expand-lg mb-4">
            <div class="container">
                <a class="navbar-brand" href="/">
                    <i class="bi bi-telegram me-2"></i>
                    Telegram Session Manager
                </a>
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
                            
                            <ul class="nav nav-tabs mb-3" id="uploadTab" role="tablist">
                                <li class="nav-item" role="presentation">
                                    <button class="nav-link active" id="paste-tab" data-bs-toggle="tab" data-bs-target="#paste" type="button" role="tab">
                                        <i class="bi bi-clipboard me-1"></i>
                                        Paste String
                                    </button>
                                </li>
                                <li class="nav-item" role="presentation">
                                    <button class="nav-link" id="file-tab" data-bs-toggle="tab" data-bs-target="#file" type="button" role="tab">
                                        <i class="bi bi-file-earmark me-1"></i>
                                        Upload File
                                    </button>
                                </li>
                            </ul>
                            
                            <div class="tab-content" id="uploadTabContent">
                                <!-- Paste String Tab -->
                                <div class="tab-pane fade show active" id="paste" role="tabpanel">
                                    <form id="pasteForm" onsubmit="pasteSessionString(); return false;">
                                        <div class="mb-3">
                                            <label class="form-label">Paste Session String</label>
                                            <textarea class="form-control session-string" id="sessionString" rows="6" 
                                                      placeholder="Paste session string like: 1BAAOMTQ5LjE1NC4xNjcuOTEBu1Ss+xWKwcKta4PzIQkDCDKXwDd4wx3ZePhfT5aWPyJorGNGjiTcw1TGJbckTl05TLU7IyBevgm...&#10;&#10;Or: 1BAAOMTQ5LjE1NC4xNjcuOTEBu1Ss+xWKwcKta4PzIQkDCDKXwDd4wx3ZePhfT5aWPyJorGNGjiTcw1TGJbckTl05TLU7IyBevgm..." 
                                                      required></textarea>
                                            <div class="form-text">
                                                Paste your Telegram session string. It usually looks like a long base64 string.
                                            </div>
                                        </div>
                                        <button type="submit" class="btn btn-primary w-100">
                                            <i class="bi bi-save me-2"></i>
                                            Save Session
                                        </button>
                                    </form>
                                </div>
                                
                                <!-- Upload File Tab -->
                                <div class="tab-pane fade" id="file" role="tabpanel">
                                    <form id="uploadForm" enctype="multipart/form-data">
                                        <div class="mb-3">
                                            <label class="form-label">Choose Session File</label>
                                            <input type="file" class="form-control" id="sessionFile" accept=".txt,.session" required>
                                            <div class="form-text">
                                                Upload .txt or .session files containing session strings
                                            </div>
                                        </div>
                                        <button type="submit" class="btn btn-primary w-100">
                                            <i class="bi bi-upload me-2"></i>
                                            Upload File
                                        </button>
                                    </form>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="card mb-4">
                        <div class="card-body">
                            <h5 class="card-title">
                                <i class="bi bi-graph-up me-2"></i>
                                Statistics
                            </h5>
                            <div id="stats">
                                <div class="alert alert-info">
                                    <i class="bi bi-hourglass-split me-2"></i>
                                    Loading statistics...
                                </div>
                            </div>
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
                                <button class="btn btn-outline-warning" onclick="disconnectAllSessions()">
                                    <i class="bi bi-plug-fill me-1"></i>
                                    Disconnect All
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
                                <div>
                                    <button class="btn btn-sm btn-outline-primary me-2" onclick="testAllSessions()">
                                        <i class="bi bi-play-circle me-1"></i>
                                        Test All
                                    </button>
                                    <button class="btn btn-sm btn-outline-primary" onclick="loadSessions()">
                                        <i class="bi bi-arrow-clockwise"></i>
                                    </button>
                                </div>
                            </div>
                            <div id="sessionsList" class="row">
                                <div class="col-12">
                                    <div class="alert alert-info">
                                        <i class="bi bi-hourglass-split me-2"></i>
                                        Loading sessions...
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="card">
                        <div class="card-body">
                            <h5 class="card-title mb-3">
                                <i class="bi bi-terminal me-2"></i>
                                Session Control Panel
                            </h5>
                            <div id="controlPanel" class="alert alert-info">
                                Select a session from the list to control it.
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Session Control Modal -->
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
                        alert('Session added successfully!');
                        document.getElementById('sessionString').value = '';
                        loadSessions();
                        loadStats();
                    } else {
                        alert('Error: ' + (result.error || 'Unknown error'));
                    }
                } catch (error) {
                    alert('Error: ' + error.message);
                }
            }
            
            async function loadSessions() {
                try {
                    const response = await fetch('/api/sessions');
                    const sessions = await response.json();
                    
                    const container = document.getElementById('sessionsList');
                    const countElement = document.getElementById('sessionCount');
                    
                    // Ensure sessions is an array
                    if (!Array.isArray(sessions)) {
                        console.error('Sessions is not an array:', sessions);
                        container.innerHTML = '<div class="col-12"><div class="alert alert-danger">Error: Could not load sessions. Invalid data format.</div></div>';
                        countElement.textContent = '0';
                        return;
                    }
                    
                    container.innerHTML = '';
                    countElement.textContent = sessions.length;
                    
                    if (sessions.length === 0) {
                        container.innerHTML = '<div class="col-12"><div class="alert alert-info">No sessions yet. Add one using the form on the left.</div></div>';
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
                                    <p class="card-text small mb-3 text-muted">
                                        <i class="bi bi-calendar me-2"></i>
                                        Added: \${session.addedAt ? new Date(session.addedAt).toLocaleDateString() : 'Unknown'}
                                    </p>
                                    <div class="d-grid gap-2">
                                        <button class="btn btn-sm btn-outline-primary" onclick="openSessionControl('\${session.id}')">
                                            <i class="bi bi-gear me-1"></i>
                                            Control
                                        </button>
                                        <button class="btn btn-sm btn-outline-success" onclick="testSession('\${session.id}')">
                                            <i class="bi bi-play-circle me-1"></i>
                                            Test
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
                    const container = document.getElementById('sessionsList');
                    container.innerHTML = '<div class="col-12"><div class="alert alert-danger">Error loading sessions: ' + error.message + '</div></div>';
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
                                        <tr>
                                            <td><strong>Phone:</strong></td>
                                            <td>\${info.user.phone || 'N/A'}</td>
                                        </tr>
                                        <tr>
                                            <td><strong>Username:</strong></td>
                                            <td>@\${info.user.username || 'N/A'}</td>
                                        </tr>
                                        <tr>
                                            <td><strong>Name:</strong></td>
                                            <td>\${info.user.firstName} \${info.user.lastName}</td>
                                        </tr>
                                        <tr>
                                            <td><strong>Status:</strong></td>
                                            <td>
                                                <span class="badge \${info.clientStatus === 'connected' ? 'bg-success' : 'bg-secondary'}">
                                                    \${info.clientStatus}
                                                </span>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td><strong>User ID:</strong></td>
                                            <td><small>\${info.user.id}</small></td>
                                        </tr>
                                    </table>
                                </div>
                            </div>
                            
                            <div class="card">
                                <div class="card-body">
                                    <h6>Quick Actions</h6>
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
                                            Get Groups (\${info.stats.groups || 0})
                                        </button>
                                        <button class="btn btn-danger" onclick="deleteSession('\${sessionId}')">
                                            <i class="bi bi-trash me-1"></i>
                                            Delete Session
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <div class="col-md-6">
                            <div class="card mb-3">
                                <div class="card-body">
                                    <h6>Send Message</h6>
                                    <form onsubmit="sendMessageFromModal('\${sessionId}'); return false;">
                                        <div class="mb-2">
                                            <label class="form-label">To (Group ID or @username)</label>
                                            <input type="text" class="form-control" id="peer_\${sessionId}" placeholder="-1001234567890 or @username" required>
                                        </div>
                                        <div class="mb-2">
                                            <label class="form-label">Message</label>
                                            <textarea class="form-control" id="message_\${sessionId}" rows="3" required></textarea>
                                        </div>
                                        <button type="submit" class="btn btn-primary w-100">
                                            <i class="bi bi-send me-1"></i>
                                            Send Message
                                        </button>
                                    </form>
                                </div>
                            </div>
                            
                            <div class="card">
                                <div class="card-body">
                                    <h6>Mass Actions</h6>
                                    <div class="d-grid gap-2">
                                        <button class="btn btn-outline-primary" onclick="getAllGroupsAndShow('\${sessionId}')">
                                            <i class="bi bi-list-ul me-1"></i>
                                            List All Groups
                                        </button>
                                        <button class="btn btn-outline-warning" onclick="forwardToAllGroupsPrompt('\${sessionId}')">
                                            <i class="bi bi-forward me-1"></i>
                                            Forward to All Groups
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="mt-3" id="sessionResults_\${sessionId}"></div>
                    \`;
                    
                    // Show modal
                    const modal = new bootstrap.Modal(document.getElementById('sessionModal'));
                    modal.show();
                    
                } catch (error) {
                    console.error('Error opening session control:', error);
                    alert('Error: ' + error.message);
                }
            }
            
            async function testSession(sessionId) {
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/test\`, { method: 'POST' });
                    const result = await response.json();
                    
                    if (result.success) {
                        alert('✅ Session is working! User: ' + result.user.firstName + ' (@' + (result.user.username || 'no-username') + ')');
                        loadSessions();
                        loadStats();
                    } else {
                        alert('❌ Session test failed: ' + (result.error || 'Unknown error'));
                    }
                } catch (error) {
                    alert('Error: ' + error.message);
                }
            }
            
            async function testAllSessions() {
                try {
                    const response = await fetch('/api/sessions/test-all', { method: 'POST' });
                    const results = await response.json();
                    
                    if (!Array.isArray(results)) {
                        alert('Error: Invalid response format');
                        return;
                    }
                    
                    let message = 'Test Results:\\n\\n';
                    results.forEach((result, index) => {
                        message += \`\${index + 1}. \${result.phone || 'Unknown'}: \${result.success ? '✅ Working' : '❌ Failed'}\\n\`;
                        if (!result.success) {
                            message += \`   Error: \${result.error || 'Unknown error'}\\n\`;
                        }
                    });
                    
                    alert(message);
                    loadSessions();
                    loadStats();
                } catch (error) {
                    alert('Error: ' + error.message);
                }
            }
            
            async function connectSession(sessionId) {
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/connect\`, { method: 'POST' });
                    const result = await response.json();
                    
                    if (result.success) {
                        alert('✅ Session connected successfully');
                        loadSessions();
                        loadStats();
                    } else {
                        alert('❌ Error: ' + (result.error || 'Failed to connect'));
                    }
                } catch (error) {
                    alert('❌ Error: ' + error.message);
                }
            }
            
            async function disconnectSession(sessionId) {
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/disconnect\`, { method: 'POST' });
                    const result = await response.json();
                    
                    if (result.success) {
                        alert('✅ Session disconnected');
                        loadSessions();
                        loadStats();
                    } else {
                        alert('❌ Error: ' + (result.error || 'Failed to disconnect'));
                    }
                } catch (error) {
                    alert('❌ Error: ' + error.message);
                }
            }
            
            async function disconnectAllSessions() {
                if (confirm('Are you sure you want to disconnect ALL sessions?')) {
                    try {
                        const response = await fetch('/api/sessions/disconnect-all', { method: 'POST' });
                        const result = await response.json();
                        
                        if (result.success) {
                            alert('✅ All sessions disconnected');
                            loadSessions();
                            loadStats();
                        } else {
                            alert('❌ Error: ' + (result.error || 'Failed to disconnect'));
                        }
                    } catch (error) {
                        alert('Error: ' + error.message);
                    }
                }
            }
            
            async function getSessionGroups(sessionId) {
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/groups\`);
                    const groups = await response.json();
                    
                    if (!Array.isArray(groups)) {
                        throw new Error('Invalid response format');
                    }
                    
                    const container = document.getElementById(\`sessionResults_\${sessionId}\`);
                    let html = '<h6 class="mt-3">Groups & Channels</h6><div class="table-responsive"><table class="table table-sm"><thead><tr><th>Title</th><th>Type</th><th>ID</th><th>Members</th><th>Actions</th></tr></thead><tbody>';
                    
                    if (groups.length === 0) {
                        html += '<tr><td colspan="5" class="text-center">No groups found</td></tr>';
                    } else {
                        groups.forEach(group => {
                            html += \`
                            <tr>
                                <td>\${group.title || 'Unknown'}</td>
                                <td><span class="badge \${group.isChannel ? 'bg-info' : 'bg-success'}">\${group.isChannel ? 'Channel' : 'Group'}</span></td>
                                <td><small>\${group.id || 'N/A'}</small></td>
                                <td>\${group.participantsCount || 'N/A'}</td>
                                <td>
                                    <button class="btn btn-sm btn-outline-primary" onclick="sendToGroup('\${sessionId}', '\${group.id}', '\${group.title}')">
                                        <i class="bi bi-send"></i>
                                    </button>
                                </td>
                            </tr>
                            \`;
                        });
                    }
                    
                    html += '</tbody></table></div>';
                    container.innerHTML = html;
                } catch (error) {
                    alert('Error getting groups: ' + error.message);
                }
            }
            
            async function getAllGroupsAndShow(sessionId) {
                try {
                    await getSessionGroups(sessionId);
                } catch (error) {
                    alert('Error: ' + error.message);
                }
            }
            
            async function sendMessageFromModal(sessionId) {
                const peer = document.getElementById(\`peer_\${sessionId}\`).value;
                const message = document.getElementById(\`message_\${sessionId}\`).value;
                
                if (!peer || !message) {
                    alert('Please fill in all fields');
                    return;
                }
                
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/send\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ peer, message })
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        alert('✅ Message sent successfully!');
                    } else {
                        alert('❌ Error: ' + (result.error || 'Failed to send'));
                    }
                } catch (error) {
                    alert('❌ Error: ' + error.message);
                }
            }
            
            async function sendToGroup(sessionId, groupId, groupTitle) {
                const message = prompt(\`Enter message to send to \${groupTitle}:\`);
                if (!message) return;
                
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/send\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ peer: groupId, message })
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        alert('✅ Message sent to group!');
                    } else {
                        alert('❌ Error: ' + (result.error || 'Failed to send'));
                    }
                } catch (error) {
                    alert('❌ Error: ' + error.message);
                }
            }
            
            async function forwardToAllGroupsPrompt(sessionId) {
                const message = prompt('Enter message to forward to all groups:');
                if (!message) return;
                
                if (!confirm(\`Are you sure you want to send this message to ALL groups of this account?\\n\\nMessage: "\${message}"\`)) {
                    return;
                }
                
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/forward\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message })
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        const successful = result.results ? result.results.filter(r => r.success).length : 0;
                        alert(\`✅ Message forwarded to \${successful} groups successfully!\`);
                    } else {
                        alert('❌ Error: ' + (result.error || 'Failed to forward'));
                    }
                } catch (error) {
                    alert('❌ Error: ' + error.message);
                }
            }
            
            async function deleteSession(sessionId) {
                if (confirm('Are you sure you want to delete this session? This cannot be undone!')) {
                    try {
                        const response = await fetch(\`/api/sessions/\${sessionId}\`, { method: 'DELETE' });
                        const result = await response.json();
                        
                        if (result.success) {
                            alert('✅ Session deleted successfully');
                            loadSessions();
                            loadStats();
                            // Close modal if open
                            const modal = bootstrap.Modal.getInstance(document.getElementById('sessionModal'));
                            if (modal) modal.hide();
                        } else {
                            alert('❌ Error: ' + (result.error || 'Failed to delete'));
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
                if (!fileInput.files[0]) {
                    alert('Please select a file');
                    return;
                }
                
                const formData = new FormData();
                formData.append('session', fileInput.files[0]);
                
                try {
                    const response = await fetch('/api/sessions/upload', {
                        method: 'POST',
                        body: formData
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        alert('✅ Session uploaded successfully!');
                        fileInput.value = '';
                        loadSessions();
                        loadStats();
                    } else {
                        alert('❌ Error: ' + (result.error || 'Upload failed'));
                    }
                } catch (error) {
                    alert('❌ Error uploading: ' + error.message);
                }
            });
            
            async function syncWithDropbox() {
                try {
                    const response = await fetch('/api/sync', { method: 'POST' });
                    const result = await response.json();
                    
                    if (result.success) {
                        alert('✅ Synced with Dropbox successfully!');
                        loadSessions();
                        loadStats();
                    } else {
                        alert('❌ Sync failed: ' + (result.error || 'Unknown error'));
                    }
                } catch (error) {
                    alert('❌ Error: ' + error.message);
                }
            }
            
            // Load stats
            async function loadStats() {
                try {
                    const response = await fetch('/api/stats');
                    const stats = await response.json();
                    
                    const statsContainer = document.getElementById('stats');
                    if (stats && typeof stats === 'object') {
                        statsContainer.innerHTML = \`
                            <p class="mb-1"><strong>Total Sessions:</strong> \${stats.totalSessions || 0}</p>
                            <p class="mb-1"><strong>Valid Sessions:</strong> \${stats.validSessions || 0}</p>
                            <p class="mb-1"><strong>Active Connections:</strong> \${stats.connectedClients || 0}</p>
                            <p class="mb-1"><strong>Messages Sent:</strong> \${stats.totalMessagesSent || 0}</p>
                            <p class="mb-0 text-muted small">
                                <i class="bi bi-cloud me-1"></i>
                                Last Sync: \${stats.lastSync ? new Date(stats.lastSync).toLocaleString() : 'Never'}
                            </p>
                        \`;
                    } else {
                        statsContainer.innerHTML = \`
                            <div class="alert alert-warning small">
                                <i class="bi bi-exclamation-triangle me-1"></i>
                                Could not load statistics
                            </div>
                        \`;
                    }
                } catch (error) {
                    console.error('Error loading stats:', error);
                    const statsContainer = document.getElementById('stats');
                    statsContainer.innerHTML = \`
                        <div class="alert alert-danger small">
                            <i class="bi bi-exclamation-triangle me-1"></i>
                            Error loading statistics: \${error.message}
                        </div>
                    \`;
                }
            }
            
            // Load sessions on page load
            document.addEventListener('DOMContentLoaded', function() {
                loadSessions();
                loadStats();
            });
            
            // Auto-refresh every 30 seconds
            setInterval(loadSessions, 30000);
            setInterval(loadStats, 30000);
        </script>
    </body>
    </html>
    `;
    
    fs.writeFileSync('public/index.html', html);
}

// ==================== AUTO LOAD SESSIONS ====================
async function autoLoadSessions() {
    try {
        console.log('🔄 Auto-loading sessions...');
        
        // Check for a session string in environment variable
        const envSession = process.env.TELEGRAM_SESSION || 
                          process.env.SESSION_STRING ||
                          "1BAAOMTQ5LjE1NC4xNjcuOTEBu1Ss+xWKwcKta4PzIQkDCDKXwDd4wx3ZePhfT5aWPyJorGNGjiTcw1TGJbckTl05TLU7IyBevgm...";
        
        if (envSession && envSession.length > 50) {
            console.log('📱 Found session string in environment');
            await processSessionStringAuto(envSession);
        }
        
        // Also auto-load from Dropbox
        await syncSessionsFromDropbox();
        
        // Connect all valid sessions
        const db = readDatabase();
        for (const session of db.sessions) {
            if (session.isValid) {
                try {
                    console.log(`🔌 Auto-connecting session: ${session.username || session.phoneNumber}`);
                    await initializeClient(session.id, session.sessionString);
                } catch (error) {
                    console.warn(`⚠️ Failed to auto-connect ${session.username || session.phoneNumber}:`, error.message);
                }
            }
        }
        
        console.log('✅ Auto-load complete');
    } catch (error) {
        console.error('❌ Auto-load failed:', error.message);
    }
}

async function processSessionStringAuto(sessionString) {
    try {
        const normalizedString = normalizeSessionString(sessionString);
        
        if (normalizedString.length < 20) {
            console.log('⚠️ Session string too short after normalization');
            return;
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
            
            console.log(`✅ Session validated for: ${userInfo.username || userInfo.phone}`);
        } catch (error) {
            console.error('❌ Session validation failed:', error.message);
            return;
        }
        
        // Check if session already exists in database
        const db = readDatabase();
        const existingSession = db.sessions.find(s => s.userId === userInfo.userId);
        
        if (existingSession) {
            console.log(`✅ Session already exists for user ${userInfo.userId}`);
            // Update the session string if different
            if (existingSession.sessionString !== normalizedString) {
                existingSession.sessionString = normalizedString;
                existingSession.lastUsed = new Date().toISOString();
                existingSession.isValid = true;
                writeDatabase(db);
                console.log(`✅ Updated session for user ${userInfo.userId}`);
            }
        } else {
            // Generate filename
            const fileName = `auto_session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.txt`;
            const localPath = path.join(SESSIONS_FOLDER, fileName);
            
            // Save locally
            fs.writeFileSync(localPath, normalizedString);
            
            // Upload to Dropbox
            await uploadSessionToDropbox(normalizedString, fileName);
            
            // Add to database
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
                sessionString: normalizedString,
                addedAt: new Date().toISOString(),
                lastUsed: null,
                isValid: true,
                status: 'inactive',
                source: 'auto'
            });
            
            writeDatabase(db);
            
            console.log(`✅ Added new session to DB: ${userInfo.username || userInfo.phone}`);
        }
        
    } catch (error) {
        console.error('❌ Error processing session:', error.message);
    }
}

// ==================== API ROUTES ====================
// Upload session file
app.post('/api/sessions/upload', upload.single('session'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }
        
        const sessionString = fs.readFileSync(req.file.path, 'utf8');
        fs.unlinkSync(req.file.path); // Clean up temp file
        
        return await processSessionStringApi(sessionString, 'file', res);
    } catch (error) {
        console.error('Error uploading session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Paste session string
app.post('/api/sessions/paste', async (req, res) => {
    try {
        const { sessionString } = req.body;
        
        if (!sessionString || sessionString.trim().length < 10) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid session string (too short)' 
            });
        }
        
        return await processSessionStringApi(sessionString, 'paste', res);
    } catch (error) {
        console.error('Error pasting session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

async function processSessionStringApi(sessionString, source, res) {
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
        await uploadSessionToDropbox(normalizedString, fileName);
        
        // Add to database
        const db = readDatabase();
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Check if session already exists (by user ID)
        const existingSession = db.sessions.find(s => s.userId === userInfo.userId);
        if (existingSession) {
            // Update existing session
            existingSession.sessionString = normalizedString;
            existingSession.fileName = fileName;
            existingSession.lastUsed = new Date().toISOString();
            existingSession.isValid = true;
            existingSession.status = 'inactive';
            existingSession.phoneNumber = userInfo.phone;
            existingSession.username = userInfo.username;
            existingSession.firstName = userInfo.firstName;
            existingSession.lastName = userInfo.lastName;
            
            console.log(`✅ Updated existing session for user ${userInfo.userId}`);
        } else {
            // Add new session
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
        
        writeDatabase(db);
        
        // Auto-connect the session
        try {
            await initializeClient(sessionId, normalizedString);
        } catch (connectError) {
            console.warn(`⚠️ Could not auto-connect session: ${connectError.message}`);
        }
        
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
app.get('/api/sessions', (req, res) => {
    try {
        const db = readDatabase();
        
        // Ensure sessions is an array
        if (!Array.isArray(db.sessions)) {
            db.sessions = [];
            writeDatabase(db);
        }
        
        // Update status based on active clients
        const sessions = db.sessions.map(session => ({
            ...session,
            sessionString: undefined, // Don't expose full session string
            status: activeClients.has(session.id) ? 'active' : session.status
        }));
        
        res.json(sessions);
    } catch (error) {
        console.error('Error getting sessions:', error);
        res.json([]);
    }
});

// Test session
app.post('/api/sessions/:sessionId/test', async (req, res) => {
    try {
        const db = readDatabase();
        const session = db.sessions.find(s => s.id === req.params.sessionId);
        
        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }
        
        try {
            const client = new TelegramClient(
                new StringSession(session.sessionString),
                config.telegramApiId,
                config.telegramApiHash,
                { connectionRetries: 2 }
            );
            
            await client.connect();
            const user = await client.getMe();
            await client.disconnect();
            
            // Update session status
            session.isValid = true;
            session.status = 'inactive';
            session.lastUsed = new Date().toISOString();
            writeDatabase(db);
            
            res.json({
                success: true,
                user: {
                    phone: user.phone,
                    username: user.username,
                    firstName: user.firstName,
                    lastName: user.lastName
                }
            });
        } catch (error) {
            session.isValid = false;
            session.status = 'error';
            session.lastError = error.message;
            writeDatabase(db);
            
            res.status(400).json({ 
                success: false, 
                error: `Session test failed: ${error.message}` 
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Test all sessions
app.post('/api/sessions/test-all', async (req, res) => {
    try {
        const db = readDatabase();
        const results = [];
        
        for (const session of db.sessions) {
            try {
                const client = new TelegramClient(
                    new StringSession(session.sessionString),
                    config.telegramApiId,
                    config.telegramApiHash,
                    { connectionRetries: 1 }
                );
                
                await client.connect();
                const user = await client.getMe();
                await client.disconnect();
                
                session.isValid = true;
                session.status = 'inactive';
                
                results.push({
                    phone: user.phone || session.phoneNumber,
                    success: true,
                    username: user.username
                });
            } catch (error) {
                session.isValid = false;
                session.status = 'error';
                session.lastError = error.message;
                
                results.push({
                    phone: session.phoneNumber,
                    success: false,
                    error: error.message
                });
            }
        }
        
        writeDatabase(db);
        res.json(results);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get session info
app.get('/api/sessions/:sessionId/info', async (req, res) => {
    try {
        const sessionInfo = await getSessionInfo(req.params.sessionId);
        res.json(sessionInfo);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Connect to session
app.post('/api/sessions/:sessionId/connect', async (req, res) => {
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
app.post('/api/sessions/:sessionId/disconnect', async (req, res) => {
    try {
        await disconnectClient(req.params.sessionId);
        res.json({ success: true, message: 'Session disconnected' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Disconnect all sessions
app.post('/api/sessions/disconnect-all', async (req, res) => {
    try {
        await disconnectAllClients();
        res.json({ success: true, message: 'All sessions disconnected' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get session groups
app.get('/api/sessions/:sessionId/groups', async (req, res) => {
    try {
        const groups = await getGroups(req.params.sessionId);
        res.json(groups);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Send message
app.post('/api/sessions/:sessionId/send', async (req, res) => {
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
app.post('/api/sessions/:sessionId/forward', async (req, res) => {
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
app.post('/api/sessions/:sessionId/add-user', async (req, res) => {
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
app.delete('/api/sessions/:sessionId', async (req, res) => {
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
app.get('/api/stats', (req, res) => {
    try {
        const db = readDatabase();
        
        // Make sure we have a proper database structure
        if (!db.sessions) db.sessions = [];
        if (!db.stats) db.stats = {};
        
        const stats = {
            totalSessions: db.sessions.length || 0,
            validSessions: db.sessions.filter(s => s.isValid).length || 0,
            connectedClients: activeClients.size || 0,
            totalMessagesSent: db.stats.totalMessagesSent || 0,
            lastSync: db.stats.lastSync || null
        };
        
        res.json(stats);
    } catch (error) {
        console.error('Error getting stats:', error);
        res.json({
            totalSessions: 0,
            validSessions: 0,
            connectedClients: 0,
            totalMessagesSent: 0,
            lastSync: null
        });
    }
});

// Sync with Dropbox
app.post('/api/sync', async (req, res) => {
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

// Direct session connect endpoint
app.post('/api/connect-direct', async (req, res) => {
    try {
        const { sessionString } = req.body;
        
        if (!sessionString || sessionString.trim().length < 10) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid session string' 
            });
        }
        
        const normalizedString = normalizeSessionString(sessionString);
        
        // Test the session
        try {
            const client = new TelegramClient(
                new StringSession(normalizedString),
                config.telegramApiId,
                config.telegramApiHash,
                { connectionRetries: 2 }
            );
            
            await client.connect();
            const user = await client.getMe();
            
            // Create a temporary session ID
            const tempSessionId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            
            // Store in active clients
            activeClients.set(tempSessionId, {
                client: client,
                userInfo: {
                    id: user.id.toString(),
                    phone: user.phone || '',
                    username: user.username || '',
                    firstName: user.firstName || '',
                    lastName: user.lastName || '',
                    isBot: user.bot || false
                },
                lastActive: Date.now(),
                connectedAt: new Date().toISOString()
            });
            
            res.json({
                success: true,
                message: 'Connected successfully',
                sessionId: tempSessionId,
                user: {
                    id: user.id,
                    phone: user.phone,
                    username: user.username,
                    firstName: user.firstName,
                    lastName: user.lastName
                }
            });
            
        } catch (error) {
            res.status(400).json({ 
                success: false, 
                error: `Failed to connect: ${error.message}` 
            });
        }
        
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

// ==================== INITIALIZE SYSTEM ====================
async function initializeSystem() {
    try {
        console.log('🚀 Initializing Telegram Session Manager...');
        
        // Initialize Dropbox
        await initializeDropbox();
        
        // Auto-load sessions (including from environment variable)
        await autoLoadSessions();
        
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
        
        console.log('✅ System initialized successfully');
        console.log(`🌐 Web interface: ${config.webBaseUrl}`);
        console.log(`☁️ Dropbox sync: ${isDropboxInitialized ? '✅ Connected' : '❌ Disconnected'}`);
        console.log(`📁 Sessions folder: ${config.dropboxSessionsFolder}`);
        console.log(`📱 Active connections: ${activeClients.size}`);
        
    } catch (error) {
        console.error('❌ Failed to initialize system:', error);
    }
}

// ==================== START SERVER ====================
const server = app.listen(config.webPort, '0.0.0.0', () => {
    console.log(`🚀 Telegram Session Manager running on port ${config.webPort}`);
    console.log(`🌐 Access at: ${config.webBaseUrl}`);
    
    // Initialize system after server is listening
    initializeSystem().catch(err => {
        console.error('System initialization error:', err);
    });
});

// Handle server errors
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${config.webPort} is already in use`);
        console.log(`Trying alternative port ${parseInt(config.webPort) + 1}...`);
        
        // Try alternative port
        const altPort = parseInt(config.webPort) + 1;
        const altServer = app.listen(altPort, '0.0.0.0', () => {
            console.log(`🚀 Server running on alternative port ${altPort}`);
            console.log(`🌐 Access at: http://localhost:${altPort}`);
            initializeSystem().catch(err => {
                console.error('System initialization error:', err);
            });
        });
        
        // Update config for auto-ping
        config.webPort = altPort;
        config.webBaseUrl = config.webBaseUrl.replace(/:\d+/, `:${altPort}`);
        
        altServer.on('error', (altError) => {
            console.error('❌ Alternative port also failed:', altError.message);
            process.exit(1);
        });
    } else {
        console.error('❌ Server error:', error);
        process.exit(1);
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🚨 Shutting down...');
    
    await disconnectAllClients();
    
    // Sync database to Dropbox
    await syncDatabaseToDropbox().catch(err => {
        console.error('Error syncing to Dropbox:', err.message);
    });
    
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
    
    // Force exit after 5 seconds
    setTimeout(() => {
        console.log('⚠️ Forcing shutdown...');
        process.exit(1);
    }, 5000);
});
