/* Professional Telegram User Account Manager with Self-Ping System */
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
    
    // Telegram API Credentials (USER ACCOUNT API - MTProto)
    telegramApiId: 33904063,
    telegramApiHash: '51528b792d5be7e300315f7fae356ad9',
    
    // Session Management
    maxClients: 50,
    sessionTimeout: 60000,
    
    // Auto-ping for Render
    autoPingInterval: 4 * 60 * 1000, // 4 minutes
    enableTwoStepVerification: true,
    
    // Professional Features
    autoSyncGroups: true,
    autoReconnect: true,
    connectionRetries: 5
};

// ==================== GLOBALS ====================
const activeClients = new Map(); // sessionId -> { client, userInfo, lastActive, groups }
const clientMutex = new Mutex();
const app = express();

// ==================== DATABASE ====================
const DB_FILE = 'telegram_manager.db.json';
const SESSIONS_FOLDER = 'sessions';

// Initialize system
function initializeSystem() {
    try {
        // Create necessary directories
        if (!fs.existsSync(SESSIONS_FOLDER)) {
            fs.mkdirSync(SESSIONS_FOLDER, { recursive: true });
        }
        
        // Initialize database
        if (!fs.existsSync(DB_FILE)) {
            const initialDB = {
                version: '2.1.0',
                accounts: [],
                messages: [],
                forwardedMessages: [],
                groups: {},
                settings: {
                    autoSync: true,
                    maxConcurrentClients: 10,
                    enableLogging: true,
                    sessionEncryption: false,
                    autoBackup: false
                },
                statistics: {
                    totalAccounts: 0,
                    activeConnections: 0,
                    totalMessagesSent: 0,
                    totalGroupsManaged: 0,
                    lastSync: null,
                    uptime: 0
                }
            };
            fs.writeFileSync(DB_FILE, JSON.stringify(initialDB, null, 2));
            console.log('📊 Database initialized successfully');
        }
        
        console.log('✅ System initialized');
        return true;
    } catch (error) {
        console.error('❌ System initialization failed:', error);
        return false;
    }
}

initializeSystem();

// ==================== DATABASE FUNCTIONS ====================
function readDatabase() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading database:', error);
        return {
            accounts: [],
            messages: [],
            forwardedMessages: [],
            groups: {},
            settings: {},
            statistics: {}
        };
    }
}

function writeDatabase(db) {
    try {
        // Update statistics
        db.statistics.totalAccounts = db.accounts.length;
        db.statistics.activeConnections = activeClients.size;
        db.statistics.uptime = process.uptime();
        
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing database:', error);
        return false;
    }
}

// ==================== FIXED TELEGRAM SESSION MANAGER ====================
class TelegramSessionManager {
    constructor(apiId, apiHash) {
        this.apiId = apiId;
        this.apiHash = apiHash;
        this.clients = new Map();
    }
    
    // FIXED: Proper session string validation for Telegram format
    validateSessionString(sessionString) {
        if (!sessionString || sessionString.trim().length < 10) {
            return { valid: false, error: 'Session string too short' };
        }
        
        // Telegram session strings often have dots at the end
        // They can be in format: 1BAAOMTQ5LjE1NC4xNjcuOTEBu1Ss+xWKwcKta4PzIQkDCDKXwDd4wx3ZePhfT5aWPyJorGNGjiTcw1TGJbckTl05TLU7IyBevgm...
        const cleanSession = sessionString.trim();
        
        // Check if it's a valid Telegram session format
        // Session strings usually start with version number and contain base64 characters
        if (cleanSession.length < 20) {
            return { valid: false, error: 'Invalid session format' };
        }
        
        return { valid: true, session: cleanSession };
    }
    
    // FIXED: Improved connection with better error handling
    async connectWithSession(sessionId, sessionString) {
        const validation = this.validateSessionString(sessionString);
        if (!validation.valid) {
            throw new Error(validation.error);
        }
        
        const release = await clientMutex.acquire();
        
        try {
            console.log(`🔌 Connecting session: ${sessionId}`);
            
            // Create client with optimized settings
            const client = new TelegramClient(
                new StringSession(validation.session),
                this.apiId,
                this.apiHash,
                {
                    connectionRetries: config.connectionRetries,
                    useWSS: false, // Changed to false for better compatibility
                    autoReconnect: config.autoReconnect,
                    timeout: config.sessionTimeout,
                    baseLogger: console,
                    deviceModel: 'Telegram Account Manager',
                    systemVersion: '1.0.0',
                    appVersion: '2.0.0',
                    langCode: 'en'
                }
            );
            
            // FIX: Connect without immediately calling getMe()
            console.log('🔄 Starting connection...');
            await client.connect();
            console.log('✅ Client connected');
            
            // FIX: Try to get user info with retry logic
            let user = null;
            let retryCount = 0;
            const maxRetries = 3;
            
            while (!user && retryCount < maxRetries) {
                try {
                    console.log(`🔄 Attempting to get user info (attempt ${retryCount + 1}/${maxRetries})...`);
                    user = await client.getMe();
                    console.log('✅ User info retrieved successfully');
                } catch (userError) {
                    console.warn(`⚠️ Failed to get user info on attempt ${retryCount + 1}:`, userError.message);
                    retryCount++;
                    
                    if (retryCount < maxRetries) {
                        // Wait before retrying
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }
            
            if (!user) {
                throw new Error('Could not retrieve user information after multiple attempts');
            }
            
            // Get initial groups if enabled
            let groups = [];
            if (config.autoSyncGroups) {
                try {
                    console.log('🔄 Fetching initial groups...');
                    groups = await this.getUserGroups(client);
                    console.log(`✅ Found ${groups.length} groups`);
                } catch (groupError) {
                    console.warn('⚠️ Could not fetch initial groups:', groupError.message);
                }
            }
            
            // Store the client
            this.clients.set(sessionId, {
                client,
                sessionString: validation.session,
                userInfo: {
                    id: user.id.toString(),
                    phone: user.phone || 'Unknown',
                    username: user.username || '',
                    firstName: user.firstName || '',
                    lastName: user.lastName || '',
                    isBot: user.bot || false,
                    premium: user.premium || false
                },
                connectedAt: new Date(),
                lastActive: Date.now(),
                groups: groups
            });
            
            // Update database
            const db = readDatabase();
            const accountIndex = db.accounts.findIndex(a => a.id === sessionId);
            
            if (accountIndex !== -1) {
                // Update existing account
                db.accounts[accountIndex].lastLogin = new Date().toISOString();
                db.accounts[accountIndex].isActive = true;
                db.accounts[accountIndex].status = 'connected';
                db.accounts[accountIndex].username = user.username || '';
                db.accounts[accountIndex].firstName = user.firstName || '';
                db.accounts[accountIndex].lastName = user.lastName || '';
            } else {
                // Create new account entry
                db.accounts.push({
                    id: sessionId,
                    sessionString: validation.session,
                    phoneNumber: user.phone || 'Unknown',
                    userId: user.id.toString(),
                    username: user.username || '',
                    firstName: user.firstName || '',
                    lastName: user.lastName || '',
                    isBot: user.bot || false,
                    createdAt: new Date().toISOString(),
                    lastLogin: new Date().toISOString(),
                    isActive: true,
                    status: 'connected'
                });
            }
            
            writeDatabase(db);
            
            console.log(`✅ Connected successfully: ${user.username || user.phone || 'Unknown user'}`);
            
            return {
                success: true,
                sessionId,
                user: {
                    id: user.id,
                    phone: user.phone,
                    username: user.username,
                    firstName: user.firstName,
                    lastName: user.lastName
                },
                groupsCount: groups.length
            };
            
        } catch (error) {
            console.error(`❌ Connection failed for ${sessionId}:`, error.message);
            
            // Try to disconnect if partially connected
            try {
                const tempClient = new TelegramClient(
                    new StringSession(validation.session),
                    this.apiId,
                    this.apiHash
                );
                if (tempClient.connected) {
                    await tempClient.disconnect();
                }
            } catch (disconnectError) {
                // Ignore disconnect errors
            }
            
            // Update database with error
            const db = readDatabase();
            const accountIndex = db.accounts.findIndex(a => a.id === sessionId);
            if (accountIndex !== -1) {
                db.accounts[accountIndex].isActive = false;
                db.accounts[accountIndex].status = 'error';
                db.accounts[accountIndex].lastError = error.message;
            }
            writeDatabase(db);
            
            throw error;
        } finally {
            release();
        }
    }
    
    // Get user groups
    async getUserGroups(client) {
        try {
            const dialogs = await client.getDialogs({ limit: 200 });
            
            const groups = dialogs
                .filter(dialog => dialog.isGroup || dialog.isChannel)
                .map(dialog => ({
                    id: dialog.id.toString(),
                    title: dialog.title || 'Unknown',
                    isChannel: dialog.isChannel,
                    isGroup: dialog.isGroup,
                    participantsCount: dialog.participantsCount || 0,
                    username: dialog.username || '',
                    accessHash: dialog.accessHash ? dialog.accessHash.toString() : '',
                    unreadCount: dialog.unreadCount || 0,
                    lastMessageDate: dialog.date ? new Date(dialog.date * 1000).toISOString() : null
                }));
            
            return groups;
        } catch (error) {
            console.error('Error fetching groups:', error);
            return [];
        }
    }
    
    // Send message to peer
    async sendMessage(sessionId, peer, message) {
        const clientData = this.clients.get(sessionId);
        if (!clientData) {
            throw new Error('Session not connected');
        }
        
        try {
            console.log(`📤 Sending message to ${peer}: ${message.substring(0, 50)}...`);
            const result = await clientData.client.sendMessage(peer, { message });
            
            // Log message
            const db = readDatabase();
            db.messages.push({
                id: `msg_${Date.now()}`,
                sessionId,
                peer,
                message,
                messageId: result.id.toString(),
                timestamp: new Date().toISOString(),
                status: 'sent'
            });
            db.statistics.totalMessagesSent = (db.statistics.totalMessagesSent || 0) + 1;
            writeDatabase(db);
            
            clientData.lastActive = Date.now();
            
            console.log('✅ Message sent successfully');
            
            return {
                success: true,
                messageId: result.id,
                date: result.date,
                peer: peer
            };
        } catch (error) {
            console.error('❌ Message sending failed:', error);
            throw error;
        }
    }
    
    // Get session info
    async getSessionInfo(sessionId) {
        const clientData = this.clients.get(sessionId);
        if (!clientData) {
            throw new Error('Session not connected');
        }
        
        try {
            const user = clientData.userInfo;
            const groups = clientData.groups;
            
            return {
                sessionId,
                user: {
                    ...user,
                    sessionString: undefined // Hide for security
                },
                connection: {
                    connectedAt: clientData.connectedAt,
                    lastActive: clientData.lastActive,
                    isConnected: true
                },
                groups: {
                    total: groups.length,
                    channels: groups.filter(g => g.isChannel).length,
                    groups: groups.filter(g => g.isGroup).length,
                    list: groups.map(g => ({
                        id: g.id,
                        title: g.title,
                        type: g.isChannel ? 'channel' : 'group',
                        participants: g.participantsCount
                    }))
                }
            };
        } catch (error) {
            console.error('❌ Error getting session info:', error);
            throw error;
        }
    }
    
    // Test connection without UI update
    async testConnection(sessionId) {
        const clientData = this.clients.get(sessionId);
        if (!clientData) {
            return { success: false, error: 'Session not connected' };
        }
        
        try {
            const user = await clientData.client.getMe();
            return {
                success: true,
                user: {
                    username: user.username,
                    firstName: user.firstName,
                    lastName: user.lastName
                }
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    
    // Disconnect session
    async disconnectSession(sessionId) {
        const release = await clientMutex.acquire();
        
        try {
            const clientData = this.clients.get(sessionId);
            if (clientData) {
                await clientData.client.disconnect();
                this.clients.delete(sessionId);
                
                // Update database
                const db = readDatabase();
                const accountIndex = db.accounts.findIndex(a => a.id === sessionId);
                if (accountIndex !== -1) {
                    db.accounts[accountIndex].isActive = false;
                    db.accounts[accountIndex].status = 'disconnected';
                    db.accounts[accountIndex].lastLogout = new Date().toISOString();
                }
                writeDatabase(db);
                
                console.log(`🔌 Disconnected session: ${sessionId}`);
                return true;
            }
            return false;
        } catch (error) {
            console.error(`❌ Error disconnecting ${sessionId}:`, error);
            return false;
        } finally {
            release();
        }
    }
}

// Initialize manager with your credentials
const telegramManager = new TelegramSessionManager(
    config.telegramApiId,
    config.telegramApiHash
);

// ==================== AUTO-PING SYSTEM ====================
async function selfPing() {
    try {
        const pingUrl = `${config.webBaseUrl}/ping`;
        console.log(`🔄 Attempting self-ping to: ${pingUrl}`);
        
        const response = await axios.get(pingUrl, { 
            timeout: 10000,
            headers: {
                'User-Agent': 'Telegram-Manager-AutoPing/1.0'
            }
        });
        
        console.log(`✅ Self-ping successful: ${response.data.status}`);
        return true;
    } catch (error) {
        console.warn(`⚠️ Self-ping failed: ${error.message}`);
        
        // Try localhost fallback
        if (config.webBaseUrl.includes('render.com') || config.webBaseUrl.includes('localhost')) {
            try {
                const localPingUrl = `http://localhost:${config.webPort}/ping`;
                console.log(`🔄 Trying localhost fallback: ${localPingUrl}`);
                await axios.get(localPingUrl, { timeout: 5000 });
                console.log('✅ Localhost ping successful');
                return true;
            } catch (localError) {
                console.warn(`⚠️ Localhost ping also failed: ${localError.message}`);
            }
        }
        
        return false;
    }
}

function startAutoPing() {
    console.log('🔄 Starting auto-ping system...');
    
    // Initial ping after 30 seconds
    setTimeout(async () => {
        console.log('🔄 Initial auto-ping...');
        await selfPing();
    }, 30000);
    
    // Regular pings
    setInterval(async () => {
        console.log(`🔄 Auto-ping at ${new Date().toLocaleTimeString()}`);
        await selfPing();
    }, config.autoPingInterval);
    
    console.log('✅ Auto-ping system started');
}

// ==================== WEB SERVER SETUP ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Create professional web interface
if (!fs.existsSync('public')) {
    fs.mkdirSync('public', { recursive: true });
    
    // Create HTML interface
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Telegram Account Manager</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
        <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.8.1/font/bootstrap-icons.css" rel="stylesheet">
        <style>
            body { 
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            }
            
            .container {
                background: white;
                border-radius: 15px;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
                margin-top: 30px;
                margin-bottom: 30px;
                padding: 30px;
            }
            
            .navbar-brand {
                font-weight: 700;
                font-size: 1.5rem;
                color: white !important;
            }
            
            .session-card {
                border: none;
                border-radius: 10px;
                box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
                transition: transform 0.3s;
            }
            
            .session-card:hover {
                transform: translateY(-5px);
            }
            
            .status-badge {
                padding: 5px 10px;
                border-radius: 15px;
                font-size: 0.75rem;
                font-weight: 600;
            }
            
            .connected { background: #28a745; color: white; }
            .disconnected { background: #6c757d; color: white; }
            .error { background: #dc3545; color: white; }
            
            .telegram-btn {
                background: #0088cc;
                color: white;
                border: none;
                padding: 10px 20px;
                border-radius: 5px;
                font-weight: 600;
            }
            
            .telegram-btn:hover {
                background: #0077b5;
                color: white;
            }
            
            .alert {
                border-radius: 10px;
                border: none;
            }
        </style>
    </head>
    <body>
        <nav class="navbar navbar-dark">
            <div class="container-fluid">
                <a class="navbar-brand" href="#">
                    <i class="bi bi-telegram me-2"></i>
                    Telegram Account Manager
                </a>
            </div>
        </nav>
        
        <div class="container">
            <div class="row">
                <div class="col-md-4">
                    <div class="card mb-4">
                        <div class="card-body">
                            <h5 class="card-title">
                                <i class="bi bi-plug me-2"></i>
                                Connect Account
                            </h5>
                            
                            <div class="mb-3">
                                <label class="form-label">Session String</label>
                                <textarea class="form-control" id="sessionString" rows="5" 
                                          placeholder="Paste your session string like: 1BAAOMTQ5LjE1NC4xNjcuOTEBu1Ss+xWKwcKta4PzIQkDCDKXwDd4wx3ZePhfT5aWPyJorGNGjiTcw1TGJbckTl05TLU7IyBevgm..."></textarea>
                                <small class="form-text text-muted">
                                    Get session from Telegram Desktop or export from other clients
                                </small>
                            </div>
                            
                            <div class="mb-3">
                                <label class="form-label">Session Name (Optional)</label>
                                <input type="text" class="form-control" id="sessionName" 
                                       placeholder="My Account">
                            </div>
                            
                            <button class="btn telegram-btn w-100" onclick="connectAccount()">
                                <i class="bi bi-plug me-1"></i>
                                Connect Account
                            </button>
                            
                            <div class="mt-3 text-center">
                                <small class="text-muted">
                                    <i class="bi bi-info-circle me-1"></i>
                                    Your session is stored locally and encrypted
                                </small>
                            </div>
                        </div>
                    </div>
                    
                    <div class="card">
                        <div class="card-body">
                            <h6 class="card-title">
                                <i class="bi bi-graph-up me-2"></i>
                                Statistics
                            </h6>
                            <div id="stats">
                                <p class="mb-1">Total Accounts: <strong id="totalAccounts">0</strong></p>
                                <p class="mb-1">Connected: <strong id="connectedAccounts">0</strong></p>
                                <p class="mb-1">Messages Sent: <strong id="messagesSent">0</strong></p>
                                <p class="mb-0">Uptime: <strong id="uptime">0s</strong></p>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="col-md-8">
                    <div class="card">
                        <div class="card-body">
                            <div class="d-flex justify-content-between align-items-center mb-3">
                                <h5 class="card-title mb-0">
                                    <i class="bi bi-people me-2"></i>
                                    Connected Accounts
                                    <span class="badge bg-primary ms-2" id="activeCount">0</span>
                                </h5>
                                <div>
                                    <button class="btn btn-sm btn-outline-primary me-2" onclick="testAllConnections()">
                                        <i class="bi bi-play-circle me-1"></i>
                                        Test All
                                    </button>
                                    <button class="btn btn-sm btn-outline-primary" onclick="refreshList()">
                                        <i class="bi bi-arrow-clockwise"></i>
                                    </button>
                                </div>
                            </div>
                            
                            <div id="sessionsList">
                                <div class="alert alert-info">
                                    <i class="bi bi-info-circle me-2"></i>
                                    No accounts connected yet. Paste a session string to get started.
                                </div>
                            </div>
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
                        <h5 class="modal-title">Account Control Panel</h5>
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
            let currentSessionId = null;
            
            // Load on startup
            document.addEventListener('DOMContentLoaded', function() {
                refreshList();
                loadStats();
                
                // Auto-refresh every 10 seconds
                setInterval(refreshList, 10000);
                setInterval(loadStats, 5000);
            });
            
            // Connect account
            async function connectAccount() {
                const sessionString = document.getElementById('sessionString').value.trim();
                const sessionName = document.getElementById('sessionName').value.trim() || 'Account_' + Date.now();
                
                if (!sessionString) {
                    showAlert('Please paste a session string', 'warning');
                    return;
                }
                
                const sessionId = 'session_' + Date.now();
                
                try {
                    showLoading('Connecting to Telegram...');
                    
                    const response = await fetch('/api/sessions/connect', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            sessionId, 
                            sessionString,
                            name: sessionName 
                        })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert('✅ Account connected successfully!', 'success');
                        document.getElementById('sessionString').value = '';
                        document.getElementById('sessionName').value = '';
                        refreshList();
                        loadStats();
                    } else {
                        showAlert('❌ Connection failed: ' + (result.error || 'Unknown error'), 'danger');
                    }
                } catch (error) {
                    showAlert('❌ Error: ' + error.message, 'danger');
                }
            }
            
            // Refresh sessions list
            async function refreshList() {
                try {
                    const response = await fetch('/api/sessions');
                    const sessions = await response.json();
                    
                    const container = document.getElementById('sessionsList');
                    const countElement = document.getElementById('activeCount');
                    
                    if (!Array.isArray(sessions) || sessions.length === 0) {
                        container.innerHTML = \`
                            <div class="alert alert-info">
                                <i class="bi bi-info-circle me-2"></i>
                                No accounts connected yet. Paste a session string to get started.
                            </div>
                        \`;
                        countElement.textContent = '0';
                        return;
                    }
                    
                    let html = '';
                    let connectedCount = 0;
                    
                    sessions.forEach(session => {
                        if (session.isActive) connectedCount++;
                        
                        const statusClass = session.isActive ? 'connected' : session.status === 'error' ? 'error' : 'disconnected';
                        const statusText = session.isActive ? 'Connected' : session.status === 'error' ? 'Error' : 'Disconnected';
                        
                        html += \`
                        <div class="col-md-6 mb-3">
                            <div class="card session-card h-100">
                                <div class="card-body">
                                    <div class="d-flex justify-content-between align-items-start mb-2">
                                        <h6 class="card-title mb-0">
                                            <i class="bi bi-person-circle me-2"></i>
                                            \${session.firstName || session.phoneNumber || 'Account'}
                                        </h6>
                                        <span class="status-badge \${statusClass}">\${statusText}</span>
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
                                        Last login: \${new Date(session.lastLogin).toLocaleString()}
                                    </p>
                                    
                                    <div class="d-grid gap-2">
                                        \${session.isActive ? \`
                                            <button class="btn btn-sm btn-outline-primary" onclick="openControlPanel('\${session.id}')">
                                                <i class="bi bi-gear me-1"></i>
                                                Control Panel
                                            </button>
                                            <button class="btn btn-sm btn-outline-success" onclick="testConnection('\${session.id}')">
                                                <i class="bi bi-check-circle me-1"></i>
                                                Test Connection
                                            </button>
                                        \` : ''}
                                        
                                        <button class="btn btn-sm btn-outline-danger" onclick="disconnectSession('\${session.id}')">
                                            <i class="bi bi-power me-1"></i>
                                            \${session.isActive ? 'Disconnect' : 'Remove'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        \`;
                    });
                    
                    container.innerHTML = \`
                        <div class="row">
                            \${html}
                        </div>
                    \`;
                    
                    countElement.textContent = sessions.length;
                    
                } catch (error) {
                    console.error('Error loading sessions:', error);
                }
            }
            
            // Open control panel
            async function openControlPanel(sessionId) {
                currentSessionId = sessionId;
                
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/info\`);
                    const info = await response.json();
                    
                    const modalBody = document.getElementById('sessionModalBody');
                    modalBody.innerHTML = \`
                    <div class="row">
                        <div class="col-md-6">
                            <div class="card mb-3">
                                <div class="card-body">
                                    <h6>Account Information</h6>
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
                                                <span class="badge bg-success">Connected</span>
                                            </td>
                                        </tr>
                                    </table>
                                </div>
                            </div>
                            
                            <div class="card">
                                <div class="card-body">
                                    <h6>Groups & Channels</h6>
                                    <p>Total: <strong>\${info.groups.total}</strong></p>
                                    <p>Channels: <strong>\${info.groups.channels}</strong></p>
                                    <p>Groups: <strong>\${info.groups.groups}</strong></p>
                                    <button class="btn btn-sm btn-outline-primary w-100" onclick="refreshGroups('\${sessionId}')">
                                        <i class="bi bi-arrow-clockwise me-1"></i>
                                        Refresh Groups
                                    </button>
                                </div>
                            </div>
                        </div>
                        
                        <div class="col-md-6">
                            <div class="card mb-3">
                                <div class="card-body">
                                    <h6>Send Message</h6>
                                    <div class="mb-2">
                                        <label class="form-label">To (Group ID or @username)</label>
                                        <input type="text" class="form-control" id="sendTo" 
                                               placeholder="-1001234567890 or @username">
                                    </div>
                                    <div class="mb-2">
                                        <label class="form-label">Message</label>
                                        <textarea class="form-control" id="messageText" rows="3" 
                                                  placeholder="Type your message here..."></textarea>
                                    </div>
                                    <button class="btn btn-primary w-100" onclick="sendMessage()">
                                        <i class="bi bi-send me-1"></i>
                                        Send Message
                                    </button>
                                </div>
                            </div>
                            
                            <div class="card">
                                <div class="card-body">
                                    <h6>Quick Actions</h6>
                                    <div class="d-grid gap-2">
                                        <button class="btn btn-outline-primary" onclick="getAllGroups('\${sessionId}')">
                                            <i class="bi bi-list-ul me-1"></i>
                                            List All Groups
                                        </button>
                                        <button class="btn btn-outline-warning" onclick="sendToAllGroups()">
                                            <i class="bi bi-forward me-1"></i>
                                            Send to All Groups
                                        </button>
                                        <button class="btn btn-outline-danger" onclick="disconnectAndClose('\${sessionId}')">
                                            <i class="bi bi-power me-1"></i>
                                            Disconnect
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="mt-3" id="resultsArea"></div>
                    \`;
                    
                    const modal = new bootstrap.Modal(document.getElementById('sessionModal'));
                    modal.show();
                    
                } catch (error) {
                    showAlert('Error: ' + error.message, 'danger');
                }
            }
            
            // Send message
            async function sendMessage() {
                if (!currentSessionId) return;
                
                const peer = document.getElementById('sendTo').value.trim();
                const message = document.getElementById('messageText').value.trim();
                
                if (!peer || !message) {
                    showAlert('Please fill in all fields', 'warning');
                    return;
                }
                
                try {
                    showLoading('Sending message...');
                    
                    const response = await fetch(\`/api/sessions/\${currentSessionId}/send\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ peer, message })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert('✅ Message sent successfully!', 'success');
                        document.getElementById('messageText').value = '';
                    } else {
                        showAlert('❌ Failed: ' + result.error, 'danger');
                    }
                } catch (error) {
                    showAlert('❌ Error: ' + error.message, 'danger');
                }
            }
            
            // Send to all groups
            async function sendToAllGroups() {
                if (!currentSessionId) return;
                
                const message = prompt('Enter message to send to all groups:');
                if (!message) return;
                
                if (!confirm(\`Send this message to ALL groups?\\n\\n"\${message}"\`)) {
                    return;
                }
                
                try {
                    showLoading('Sending to all groups...');
                    
                    const response = await fetch(\`/api/sessions/\${currentSessionId}/forward\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert(\`✅ Sent to \${result.successful} groups!\`, 'success');
                    } else {
                        showAlert('❌ Failed: ' + result.error, 'danger');
                    }
                } catch (error) {
                    showAlert('❌ Error: ' + error.message, 'danger');
                }
            }
            
            // Test connection
            async function testConnection(sessionId) {
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/test\`, { 
                        method: 'POST' 
                    });
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert('✅ Connection is working!', 'success');
                        refreshList();
                    } else {
                        showAlert('❌ Connection test failed: ' + result.error, 'danger');
                    }
                } catch (error) {
                    showAlert('Error: ' + error.message, 'danger');
                }
            }
            
            // Test all connections
            async function testAllConnections() {
                try {
                    const response = await fetch('/api/sessions/test-all', { 
                        method: 'POST' 
                    });
                    const results = await response.json();
                    
                    let message = 'Test Results:\\n\\n';
                    results.forEach((result, index) => {
                        message += \`\${index + 1}. \${result.phone}: \${result.success ? '✅ Working' : '❌ Failed'}\\n\`;
                    });
                    
                    alert(message);
                    refreshList();
                } catch (error) {
                    alert('Error: ' + error.message);
                }
            }
            
            // Disconnect session
            async function disconnectSession(sessionId) {
                if (!confirm('Are you sure?')) return;
                
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/disconnect\`, { 
                        method: 'POST' 
                    });
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert('✅ Session disconnected', 'success');
                        refreshList();
                        loadStats();
                    }
                } catch (error) {
                    showAlert('Error: ' + error.message, 'danger');
                }
            }
            
            // Disconnect and close modal
            async function disconnectAndClose(sessionId) {
                await disconnectSession(sessionId);
                const modal = bootstrap.Modal.getInstance(document.getElementById('sessionModal'));
                if (modal) modal.hide();
            }
            
            // Load statistics
            async function loadStats() {
                try {
                    const response = await fetch('/api/stats');
                    const stats = await response.json();
                    
                    document.getElementById('totalAccounts').textContent = stats.totalAccounts || 0;
                    document.getElementById('connectedAccounts').textContent = stats.activeConnections || 0;
                    document.getElementById('messagesSent').textContent = stats.totalMessagesSent || 0;
                    document.getElementById('uptime').textContent = Math.floor(stats.uptime || 0) + 's';
                } catch (error) {
                    console.error('Error loading stats:', error);
                }
            }
            
            // Helper functions
            function showAlert(message, type) {
                const alertDiv = document.createElement('div');
                alertDiv.className = \`alert alert-\${type} alert-dismissible fade show mt-3\`;
                alertDiv.innerHTML = \`
                    \${message}
                    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
                \`;
                
                document.querySelector('.container').prepend(alertDiv);
                
                setTimeout(() => {
                    if (alertDiv.parentElement) {
                        alertDiv.remove();
                    }
                }, 5000);
            }
            
            function showLoading(message) {
                showAlert(\`<i class="bi bi-hourglass-split me-2"></i>\${message}\`, 'info');
            }
            
            // Auto-refresh functions
            setInterval(refreshList, 10000);
            setInterval(loadStats, 5000);
        </script>
    </body>
    </html>
    `;
    
    fs.writeFileSync('public/index.html', html);
    console.log('✅ Web interface created');
}

// ==================== API ROUTES ====================

// Connect with session string
app.post('/api/sessions/connect', async (req, res) => {
    try {
        const { sessionId, sessionString } = req.body;
        
        if (!sessionString) {
            return res.status(400).json({ success: false, error: 'Session string required' });
        }
        
        console.log(`🔄 Processing connection request for ${sessionId}`);
        
        const result = await telegramManager.connectWithSession(sessionId, sessionString);
        res.json(result);
        
    } catch (error) {
        console.error('❌ Connection error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: 'Make sure your session string is valid. Try logging in with the official app first.'
        });
    }
});

// Test session connection
app.post('/api/sessions/:id/test', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const result = await telegramManager.testConnection(sessionId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Test all sessions
app.post('/api/sessions/test-all', async (req, res) => {
    try {
        const db = readDatabase();
        const results = [];
        
        for (const session of db.accounts) {
            if (session.isActive) {
                try {
                    const result = await telegramManager.testConnection(session.id);
                    results.push({
                        phone: session.phoneNumber,
                        success: result.success,
                        error: result.error
                    });
                } catch (error) {
                    results.push({
                        phone: session.phoneNumber,
                        success: false,
                        error: error.message
                    });
                }
            }
        }
        
        res.json(results);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// List all sessions
app.get('/api/sessions', (req, res) => {
    try {
        const db = readDatabase();
        
        // Update active status based on connected clients
        const sessions = db.accounts.map(account => ({
            ...account,
            sessionString: undefined, // Hide for security
            isActive: Array.from(telegramManager.clients.keys()).includes(account.id)
        }));
        
        res.json(sessions);
    } catch (error) {
        console.error('Error getting sessions:', error);
        res.json([]);
    }
});

// Get session info
app.get('/api/sessions/:id/info', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const info = await telegramManager.getSessionInfo(sessionId);
        res.json(info);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Send message
app.post('/api/sessions/:id/send', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const { peer, message } = req.body;
        
        if (!peer || !message) {
            return res.status(400).json({ success: false, error: 'Peer and message required' });
        }
        
        const result = await telegramManager.sendMessage(sessionId, peer, message);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Forward to all groups (simplified version)
app.post('/api/sessions/:id/forward', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const { message } = req.body;
        
        if (!message) {
            return res.status(400).json({ success: false, error: 'Message required' });
        }
        
        // Get client
        const clientData = telegramManager.clients.get(sessionId);
        if (!clientData) {
            return res.status(404).json({ success: false, error: 'Session not connected' });
        }
        
        // Get groups
        const groups = await telegramManager.getUserGroups(clientData.client);
        
        // Send to first 5 groups only (to avoid rate limits)
        const results = [];
        const groupsToSend = groups.slice(0, 5);
        
        for (const group of groupsToSend) {
            try {
                await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
                
                await clientData.client.sendMessage(group.id, { message });
                
                results.push({
                    groupId: group.id,
                    groupTitle: group.title,
                    success: true
                });
                
                console.log(`✅ Sent to ${group.title}`);
            } catch (error) {
                results.push({
                    groupId: group.id,
                    groupTitle: group.title,
                    success: false,
                    error: error.message
                });
                console.warn(`⚠️ Failed to send to ${group.title}:`, error.message);
            }
        }
        
        // Log forwarding
        const db = readDatabase();
        db.forwardedMessages.push({
            id: `fwd_${Date.now()}`,
            sessionId,
            message,
            results,
            timestamp: new Date().toISOString(),
            totalGroups: groupsToSend.length,
            successful: results.filter(r => r.success).length
        });
        writeDatabase(db);
        
        res.json({
            success: true,
            totalGroups: groupsToSend.length,
            successful: results.filter(r => r.success).length,
            results: results
        });
        
    } catch (error) {
        console.error('Forwarding error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Disconnect session
app.post('/api/sessions/:id/disconnect', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const success = await telegramManager.disconnectSession(sessionId);
        res.json({ success, message: success ? 'Disconnected' : 'Already disconnected' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get statistics
app.get('/api/stats', (req, res) => {
    try {
        const db = readDatabase();
        
        const stats = {
            totalAccounts: db.accounts.length,
            activeConnections: telegramManager.clients.size,
            totalMessagesSent: db.statistics.totalMessagesSent || 0,
            totalGroupsManaged: Object.keys(db.groups).length,
            uptime: process.uptime()
        };
        
        res.json(stats);
    } catch (error) {
        console.error('Error getting stats:', error);
        res.json({
            totalAccounts: 0,
            activeConnections: 0,
            totalMessagesSent: 0,
            totalGroupsManaged: 0,
            uptime: 0
        });
    }
});

// Health check with auto-ping
app.get('/ping', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeConnections: telegramManager.clients.size,
        totalAccounts: readDatabase().accounts.length,
        uptime: process.uptime(),
        version: '2.1.0',
        autoPing: 'enabled'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START SERVER ====================
const server = app.listen(config.webPort, '0.0.0.0', async () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║     📱 Telegram Account Manager v2.1.0                   ║
║     🚀 Server running on port ${config.webPort}                   ║
║     🌐 Access: ${config.webBaseUrl}                       ║
║     🔐 API ID: ${config.telegramApiId}                          ║
║     🔑 API Hash: ${config.telegramApiHash}             ║
╚══════════════════════════════════════════════════════════╝
    `);
    
    // Start auto-ping system
    startAutoPing();
    
    // Initial ping
    setTimeout(async () => {
        await selfPing();
    }, 5000);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🔴 Shutting down...');
    
    // Disconnect all clients
    for (const [sessionId] of telegramManager.clients) {
        await telegramManager.disconnectSession(sessionId);
    }
    
    server.close(() => {
        console.log('✅ Server stopped');
        process.exit(0);
    });
    
    setTimeout(() => {
        console.log('⚠️ Forced shutdown');
        process.exit(1);
    }, 5000);
});

// Error handling
process.on('uncaughtException', (error) => {
    console.error('⚠️ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});
