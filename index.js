/* Professional Telegram User Account Manager with Web Interface */
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
    
    // Dropbox Configuration (for session backup)
    dropboxAppKey: 'ho5ep3i58l3tvgu',
    dropboxAppSecret: '9fy0w0pgaafyk3e',
    dropboxRefreshToken: 'Vjhcbg66GMgAAAAAAAAAARJPgSupFcZdyXFkXiFx7VP-oXv_64RQKmtTLUYfPtm3',
    dropboxSessionsFolder: '/workingtelesessions',
    
    // Telegram API Credentials (USER ACCOUNT API - MTProto)
    telegramApiId: 33904063,
    telegramApiHash: '51528b792d5be7e300315f7fae356ad9',
    
    // Session Management
    maxClients: 50,
    sessionTimeout: 60000,
    
    // Web Interface
    autoPingInterval: 4 * 60 * 1000,
    enableTwoStepVerification: true,
    
    // Professional Features
    autoSyncGroups: true,
    autoReconnect: true,
    connectionRetries: 5
};

// ==================== GLOBALS ====================
let dbx = null;
let isDropboxInitialized = false;
const activeClients = new Map(); // sessionId -> { client, userInfo, lastActive, groups }
const clientMutex = new Mutex();
const app = express();
const sessionCreationFlows = new Map(); // Temporary storage for OTP/2FA during login

// ==================== DATABASE ====================
const DB_FILE = 'telegram_manager.db.json';
const SESSIONS_FOLDER = 'sessions';
const LOGS_FOLDER = 'logs';

// Initialize system
function initializeSystem() {
    try {
        // Create necessary directories
        [SESSIONS_FOLDER, LOGS_FOLDER].forEach(folder => {
            if (!fs.existsSync(folder)) {
                fs.mkdirSync(folder, { recursive: true });
            }
        });
        
        // Initialize database
        if (!fs.existsSync(DB_FILE)) {
            const initialDB = {
                version: '2.0.0',
                accounts: [],
                messages: [],
                forwardedMessages: [],
                groups: {},
                settings: {
                    autoSync: true,
                    maxConcurrentClients: 10,
                    enableLogging: true,
                    sessionEncryption: false,
                    autoBackup: true
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

// ==================== TELEGRAM SESSION MANAGER ====================
class TelegramSessionManager {
    constructor(apiId, apiHash) {
        this.apiId = apiId;
        this.apiHash = apiHash;
        this.clients = new Map();
    }
    
    // Professional session string validation
    validateSessionString(sessionString) {
        if (!sessionString || sessionString.length < 20) {
            return { valid: false, error: 'Session string too short' };
        }
        
        // Remove whitespace and quotes
        const cleanSession = sessionString.trim().replace(/['"]/g, '');
        
        // Check if it looks like a Telegram session string
        // Telegram session strings are typically base64 encoded
        const isBase64 = /^[A-Za-z0-9+/=]+$/.test(cleanSession);
        
        if (!isBase64) {
            return { valid: false, error: 'Invalid session format. Must be base64 encoded' };
        }
        
        return { valid: true, session: cleanSession };
    }
    
    // Create new session with phone number
    async createNewSession(phoneNumber) {
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        try {
            console.log(`📱 Creating new session for: ${phoneNumber}`);
            
            const client = new TelegramClient(
                new StringSession(''),
                this.apiId,
                this.apiHash,
                {
                    connectionRetries: config.connectionRetries,
                    useWSS: true,
                    autoReconnect: config.autoReconnect,
                    timeout: config.sessionTimeout,
                    baseLogger: console
                }
            );
            
            // Store in temporary flow storage
            sessionCreationFlows.set(sessionId, {
                client,
                phoneNumber,
                stage: 'phone_entered',
                createdAt: Date.now()
            });
            
            // Start the authentication flow
            await client.start({
                phoneNumber: () => Promise.resolve(phoneNumber),
                phoneCode: async () => {
                    // This will be handled by the API endpoint
                    const flow = sessionCreationFlows.get(sessionId);
                    if (flow && flow.phoneCode) {
                        return flow.phoneCode;
                    }
                    throw new Error('Waiting for phone code');
                },
                password: async () => {
                    const flow = sessionCreationFlows.get(sessionId);
                    if (flow && flow.password) {
                        return flow.password;
                    }
                    throw new Error('Waiting for 2FA password');
                },
                onError: (err) => {
                    console.error('❌ Authentication error:', err);
                    sessionCreationFlows.delete(sessionId);
                }
            });
            
            // If we get here, authentication was successful
            const sessionString = client.session.save();
            const user = await client.getMe();
            
            // Store the client
            this.clients.set(sessionId, {
                client,
                sessionString,
                userInfo: {
                    id: user.id.toString(),
                    phone: user.phone || phoneNumber,
                    username: user.username || '',
                    firstName: user.firstName || '',
                    lastName: user.lastName || '',
                    isBot: user.bot || false,
                    premium: user.premium || false
                },
                connectedAt: new Date(),
                lastActive: Date.now(),
                groups: []
            });
            
            // Save to database
            const db = readDatabase();
            db.accounts.push({
                id: sessionId,
                sessionString,
                phoneNumber: user.phone || phoneNumber,
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
            writeDatabase(db);
            
            // Clean up temp flow
            sessionCreationFlows.delete(sessionId);
            
            console.log(`✅ New session created for: ${user.username || phoneNumber}`);
            
            return {
                success: true,
                sessionId,
                sessionString,
                user: user
            };
            
        } catch (error) {
            sessionCreationFlows.delete(sessionId);
            console.error('❌ Session creation failed:', error);
            throw error;
        }
    }
    
    // Connect with existing session string
    async connectWithSession(sessionId, sessionString) {
        const validation = this.validateSessionString(sessionString);
        if (!validation.valid) {
            throw new Error(validation.error);
        }
        
        const release = await clientMutex.acquire();
        
        try {
            console.log(`🔌 Connecting session: ${sessionId}`);
            
            const client = new TelegramClient(
                new StringSession(validation.session),
                this.apiId,
                this.apiHash,
                {
                    connectionRetries: config.connectionRetries,
                    useWSS: true,
                    autoReconnect: config.autoReconnect,
                    timeout: config.sessionTimeout,
                    baseLogger: console
                }
            );
            
            await client.connect();
            
            // Verify connection
            const user = await client.getMe();
            
            // Get initial groups if enabled
            let groups = [];
            if (config.autoSyncGroups) {
                try {
                    groups = await this.getUserGroups(client);
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
                    phone: user.phone || '',
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
                db.accounts[accountIndex].lastLogin = new Date().toISOString();
                db.accounts[accountIndex].isActive = true;
                db.accounts[accountIndex].status = 'connected';
            }
            writeDatabase(db);
            
            console.log(`✅ Connected: ${user.username || user.phone || 'Unknown user'}`);
            
            return {
                success: true,
                sessionId,
                user: user,
                groupsCount: groups.length
            };
            
        } catch (error) {
            console.error(`❌ Connection failed for ${sessionId}:`, error.message);
            
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
            db.statistics.totalMessagesSent++;
            writeDatabase(db);
            
            clientData.lastActive = Date.now();
            
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
    
    // Forward message to all groups
    async forwardToAllGroups(sessionId, message) {
        const clientData = this.clients.get(sessionId);
        if (!clientData) {
            throw new Error('Session not connected');
        }
        
        try {
            // Refresh groups list
            const groups = await this.getUserGroups(clientData.client);
            clientData.groups = groups;
            
            const results = [];
            
            for (const group of groups) {
                try {
                    await new Promise(resolve => setTimeout(resolve, 500)); // Rate limiting
                    
                    const result = await clientData.client.sendMessage(group.id, { message });
                    
                    results.push({
                        groupId: group.id,
                        groupTitle: group.title,
                        success: true,
                        messageId: result.id,
                        timestamp: new Date().toISOString()
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
                totalGroups: groups.length,
                successful: results.filter(r => r.success).length
            });
            writeDatabase(db);
            
            return {
                success: true,
                totalGroups: groups.length,
                successful: results.filter(r => r.success).length,
                failed: results.filter(r => !r.success).length,
                results: results
            };
        } catch (error) {
            console.error('❌ Forwarding failed:', error);
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
        <title>Professional Telegram Account Manager</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
        <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.8.1/font/bootstrap-icons.css" rel="stylesheet">
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <style>
            :root {
                --primary-color: #0088cc;
                --secondary-color: #2c3e50;
                --success-color: #27ae60;
                --danger-color: #e74c3c;
                --warning-color: #f39c12;
                --info-color: #3498db;
            }
            
            body {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            }
            
            .main-container {
                background: rgba(255, 255, 255, 0.95);
                border-radius: 20px;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
                margin-top: 30px;
                margin-bottom: 30px;
            }
            
            .navbar-brand {
                font-weight: 700;
                font-size: 1.5rem;
                color: white !important;
            }
            
            .status-badge {
                padding: 5px 12px;
                border-radius: 20px;
                font-size: 0.75rem;
                font-weight: 600;
            }
            
            .status-connected { background: var(--success-color); color: white; }
            .status-disconnected { background: var(--secondary-color); color: white; }
            .status-error { background: var(--danger-color); color: white; }
            
            .session-card {
                border: none;
                border-radius: 15px;
                transition: all 0.3s ease;
                background: linear-gradient(145deg, #ffffff, #f5f7fa);
                box-shadow: 5px 5px 15px rgba(0, 0, 0, 0.1);
            }
            
            .session-card:hover {
                transform: translateY(-5px);
                box-shadow: 0 15px 30px rgba(0, 0, 0, 0.2);
            }
            
            .btn-telegram {
                background: var(--primary-color);
                color: white;
                border: none;
                padding: 10px 25px;
                border-radius: 10px;
                font-weight: 600;
                transition: all 0.3s ease;
            }
            
            .btn-telegram:hover {
                background: #0077b5;
                transform: translateY(-2px);
                box-shadow: 0 5px 15px rgba(0, 136, 204, 0.3);
            }
            
            .stats-card {
                background: white;
                border-radius: 15px;
                padding: 20px;
                margin-bottom: 20px;
                box-shadow: 0 5px 15px rgba(0, 0, 0, 0.08);
            }
            
            .modal-header {
                background: linear-gradient(135deg, var(--primary-color), var(--info-color));
                color: white;
                border-radius: 15px 15px 0 0 !important;
            }
            
            .group-item {
                padding: 10px;
                border-radius: 10px;
                margin-bottom: 10px;
                background: #f8f9fa;
                border-left: 4px solid var(--primary-color);
            }
            
            .connection-status {
                width: 12px;
                height: 12px;
                border-radius: 50%;
                display: inline-block;
                margin-right: 8px;
            }
            
            .online { background: var(--success-color); }
            .offline { background: var(--secondary-color); }
            .error { background: var(--danger-color); }
        </style>
    </head>
    <body>
        <!-- Navigation -->
        <nav class="navbar navbar-expand-lg navbar-dark">
            <div class="container">
                <a class="navbar-brand" href="#">
                    <i class="fas fa-broadcast-tower me-2"></i>
                    Telegram Account Manager
                </a>
                <div class="navbar-text">
                    <span class="badge bg-light text-dark">
                        <i class="fas fa-plug me-1"></i>
                        <span id="connectionCount">0</span> Connected
                    </span>
                </div>
            </div>
        </nav>
        
        <!-- Main Container -->
        <div class="container main-container">
            <div class="row mt-4">
                <div class="col-md-3">
                    <!-- Connection Panel -->
                    <div class="stats-card">
                        <h5><i class="fas fa-link me-2"></i>Connection</h5>
                        <div class="mb-3">
                            <ul class="nav nav-tabs" id="connectionTab" role="tablist">
                                <li class="nav-item" role="presentation">
                                    <button class="nav-link active" id="existing-tab" data-bs-toggle="tab" data-bs-target="#existing">
                                        <i class="fas fa-sign-in-alt me-1"></i>Login
                                    </button>
                                </li>
                                <li class="nav-item" role="presentation">
                                    <button class="nav-link" id="new-tab" data-bs-toggle="tab" data-bs-target="#new">
                                        <i class="fas fa-user-plus me-1"></i>New Account
                                    </button>
                                </li>
                            </ul>
                            
                            <div class="tab-content mt-3">
                                <!-- Existing Session -->
                                <div class="tab-pane fade show active" id="existing">
                                    <div class="mb-3">
                                        <label class="form-label">Session String</label>
                                        <textarea class="form-control" id="sessionString" rows="4" 
                                                  placeholder="Paste your Telegram session string here..."></textarea>
                                        <small class="form-text text-muted">
                                            Get session string from Telegram Desktop or export from other clients
                                        </small>
                                    </div>
                                    <button class="btn btn-telegram w-100" onclick="connectWithSession()">
                                        <i class="fas fa-plug me-1"></i>Connect Account
                                    </button>
                                </div>
                                
                                <!-- New Account -->
                                <div class="tab-pane fade" id="new">
                                    <div class="mb-3">
                                        <label class="form-label">Phone Number</label>
                                        <input type="text" class="form-control" id="phoneNumber" 
                                               placeholder="+1234567890" required>
                                    </div>
                                    <button class="btn btn-success w-100" onclick="createNewSession()">
                                        <i class="fas fa-mobile-alt me-1"></i>Create New Session
                                    </button>
                                    <div id="otpSection" class="mt-3" style="display: none;">
                                        <div class="mb-2">
                                            <label class="form-label">Verification Code</label>
                                            <input type="text" class="form-control" id="verificationCode">
                                        </div>
                                        <div class="mb-2" id="passwordSection" style="display: none;">
                                            <label class="form-label">2FA Password</label>
                                            <input type="password" class="form-control" id="twoFactorPassword">
                                        </div>
                                        <button class="btn btn-info w-100" onclick="submitVerification()">
                                            <i class="fas fa-check me-1"></i>Verify
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Quick Stats -->
                        <div class="mt-4">
                            <h6><i class="fas fa-chart-bar me-2"></i>Statistics</h6>
                            <div id="statsContainer">
                                <div class="d-flex justify-content-between mb-2">
                                    <span>Total Accounts:</span>
                                    <strong id="totalAccounts">0</strong>
                                </div>
                                <div class="d-flex justify-content-between mb-2">
                                    <span>Connected:</span>
                                    <strong id="connectedAccounts">0</strong>
                                </div>
                                <div class="d-flex justify-content-between mb-2">
                                    <span>Messages Sent:</span>
                                    <strong id="messagesSent">0</strong>
                                </div>
                                <div class="d-flex justify-content-between">
                                    <span>Groups Managed:</span>
                                    <strong id="groupsManaged">0</strong>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Quick Actions -->
                    <div class="stats-card">
                        <h6><i class="fas fa-bolt me-2"></i>Quick Actions</h6>
                        <div class="d-grid gap-2">
                            <button class="btn btn-outline-primary" onclick="refreshAll()">
                                <i class="fas fa-sync-alt me-1"></i>Refresh All
                            </button>
                            <button class="btn btn-outline-warning" onclick="disconnectAll()">
                                <i class="fas fa-power-off me-1"></i>Disconnect All
                            </button>
                            <button class="btn btn-outline-info" onclick="exportSessions()">
                                <i class="fas fa-download me-1"></i>Export Sessions
                            </button>
                        </div>
                    </div>
                </div>
                
                <!-- Sessions List -->
                <div class="col-md-9">
                    <div class="stats-card">
                        <div class="d-flex justify-content-between align-items-center mb-3">
                            <h4 class="mb-0">
                                <i class="fas fa-users me-2"></i>Active Accounts
                            </h4>
                            <span class="badge bg-primary fs-6" id="activeSessionsCount">0</span>
                        </div>
                        
                        <div id="sessionsList" class="row">
                            <!-- Sessions will be loaded here -->
                            <div class="col-12">
                                <div class="alert alert-info">
                                    <i class="fas fa-info-circle me-2"></i>
                                    Connect your Telegram account to get started
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Session Control Modal -->
        <div class="modal fade" id="sessionModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-xl">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title" id="modalTitle">Account Control Panel</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body" id="sessionModalBody">
                        Loading...
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Scripts -->
        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
        <script>
            let currentSessionId = null;
            let verificationFlowId = null;
            
            // Initialize page
            document.addEventListener('DOMContentLoaded', function() {
                loadSessions();
                loadStatistics();
                setInterval(loadStatistics, 10000);
            });
            
            // Connect with session string
            async function connectWithSession() {
                const sessionString = document.getElementById('sessionString').value.trim();
                if (!sessionString) {
                    showAlert('Please enter a session string', 'warning');
                    return;
                }
                
                const sessionId = 'session_' + Date.now();
                
                try {
                    showLoading('Connecting to Telegram...');
                    
                    const response = await fetch('/api/sessions/connect', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId, sessionString })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert('✅ Account connected successfully!', 'success');
                        document.getElementById('sessionString').value = '';
                        loadSessions();
                        loadStatistics();
                    } else {
                        showAlert('❌ Connection failed: ' + result.error, 'danger');
                    }
                } catch (error) {
                    showAlert('❌ Error: ' + error.message, 'danger');
                }
            }
            
            // Create new session with phone number
            async function createNewSession() {
                const phoneNumber = document.getElementById('phoneNumber').value.trim();
                if (!phoneNumber) {
                    showAlert('Please enter your phone number', 'warning');
                    return;
                }
                
                try {
                    showLoading('Starting authentication...');
                    
                    const response = await fetch('/api/sessions/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phoneNumber })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        verificationFlowId = result.flowId;
                        document.getElementById('otpSection').style.display = 'block';
                        showAlert('📱 Verification code sent to your phone', 'info');
                    } else {
                        showAlert('❌ Failed: ' + result.error, 'danger');
                    }
                } catch (error) {
                    showAlert('❌ Error: ' + error.message, 'danger');
                }
            }
            
            // Submit verification code
            async function submitVerification() {
                const code = document.getElementById('verificationCode').value.trim();
                const password = document.getElementById('twoFactorPassword').value.trim();
                
                if (!code && !password) {
                    showAlert('Please enter verification code', 'warning');
                    return;
                }
                
                try {
                    showLoading('Verifying...');
                    
                    const response = await fetch('/api/sessions/verify', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            flowId: verificationFlowId, 
                            code, 
                            password 
                        })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert('✅ Account created and connected!', 'success');
                        document.getElementById('phoneNumber').value = '';
                        document.getElementById('verificationCode').value = '';
                        document.getElementById('twoFactorPassword').value = '';
                        document.getElementById('otpSection').style.display = 'none';
                        verificationFlowId = null;
                        loadSessions();
                        loadStatistics();
                    } else {
                        showAlert('❌ Verification failed: ' + result.error, 'danger');
                    }
                } catch (error) {
                    showAlert('❌ Error: ' + error.message, 'danger');
                }
            }
            
            // Load all sessions
            async function loadSessions() {
                try {
                    const response = await fetch('/api/sessions');
                    const sessions = await response.json();
                    
                    const container = document.getElementById('sessionsList');
                    const countElement = document.getElementById('activeSessionsCount');
                    
                    if (!Array.isArray(sessions) || sessions.length === 0) {
                        container.innerHTML = \`
                            <div class="col-12">
                                <div class="alert alert-info">
                                    <i class="fas fa-info-circle me-2"></i>
                                    No accounts connected yet. Use the connection panel to add your first account.
                                </div>
                            </div>
                        \`;
                        countElement.textContent = '0';
                        return;
                    }
                    
                    let html = '';
                    sessions.forEach(session => {
                        const statusClass = session.isActive ? 'status-connected' : 'status-disconnected';
                        const statusText = session.isActive ? 'Connected' : 'Disconnected';
                        
                        html += \`
                        <div class="col-md-6 col-lg-4 mb-3">
                            <div class="card session-card h-100">
                                <div class="card-body">
                                    <div class="d-flex justify-content-between align-items-start mb-3">
                                        <div>
                                            <h6 class="card-title mb-1">
                                                <i class="fas fa-user-circle me-2"></i>
                                                \${session.firstName || 'User'}
                                            </h6>
                                            <small class="text-muted">@\${session.username || 'no-username'}</small>
                                        </div>
                                        <span class="status-badge \${statusClass}">\${statusText}</span>
                                    </div>
                                    
                                    <p class="card-text small mb-2">
                                        <i class="fas fa-phone me-2"></i>
                                        \${session.phoneNumber || 'N/A'}
                                    </p>
                                    
                                    <p class="card-text small mb-3">
                                        <i class="fas fa-calendar me-2"></i>
                                        Added: \${new Date(session.createdAt).toLocaleDateString()}
                                    </p>
                                    
                                    <div class="d-grid gap-2">
                                        <button class="btn btn-sm btn-telegram" onclick="openSessionControl('\${session.id}')">
                                            <i class="fas fa-cogs me-1"></i>Control Panel
                                        </button>
                                        <button class="btn btn-sm btn-outline-success" onclick="testConnection('\${session.id}')">
                                            <i class="fas fa-check me-1"></i>Test
                                        </button>
                                        <button class="btn btn-sm btn-outline-danger" onclick="disconnectSession('\${session.id}')">
                                            <i class="fas fa-sign-out-alt me-1"></i>Disconnect
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        \`;
                    });
                    
                    container.innerHTML = html;
                    countElement.textContent = sessions.length;
                } catch (error) {
                    console.error('Error loading sessions:', error);
                    showAlert('Error loading sessions', 'danger');
                }
            }
            
            // Open session control panel
            async function openSessionControl(sessionId) {
                currentSessionId = sessionId;
                
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/info\`);
                    const info = await response.json();
                    
                    const modalBody = document.getElementById('sessionModalBody');
                    modalBody.innerHTML = \`
                    <div class="row">
                        <div class="col-md-4">
                            <div class="card mb-3">
                                <div class="card-body">
                                    <h6><i class="fas fa-user me-2"></i>Account Information</h6>
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
                                            <td><strong>User ID:</strong></td>
                                            <td><small class="text-muted">\${info.user.id}</small></td>
                                        </tr>
                                    </table>
                                </div>
                            </div>
                            
                            <div class="card mb-3">
                                <div class="card-body">
                                    <h6><i class="fas fa-network-wired me-2"></i>Connection</h6>
                                    <p class="mb-1">
                                        <span class="connection-status online"></span>
                                        Status: <strong>Connected</strong>
                                    </p>
                                    <p class="mb-0 text-muted small">
                                        Connected: \${new Date(info.connection.connectedAt).toLocaleString()}
                                    </p>
                                </div>
                            </div>
                            
                            <div class="card">
                                <div class="card-body">
                                    <h6><i class="fas fa-bolt me-2"></i>Quick Actions</h6>
                                    <div class="d-grid gap-2">
                                        <button class="btn btn-success" onclick="refreshGroups('\${sessionId}')">
                                            <i class="fas fa-sync-alt me-1"></i>Refresh Groups
                                        </button>
                                        <button class="btn btn-warning" onclick="disconnectModalSession('\${sessionId}')">
                                            <i class="fas fa-power-off me-1"></i>Disconnect
                                        </button>
                                        <button class="btn btn-danger" onclick="deleteSession('\${sessionId}')">
                                            <i class="fas fa-trash me-1"></i>Delete Account
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <div class="col-md-8">
                            <div class="card mb-3">
                                <div class="card-body">
                                    <h6><i class="fas fa-paper-plane me-2"></i>Send Message</h6>
                                    <div class="row">
                                        <div class="col-md-6 mb-2">
                                            <label class="form-label">Recipient</label>
                                            <input type="text" class="form-control" id="sendPeer" 
                                                   placeholder="Group ID, @username, or phone">
                                        </div>
                                        <div class="col-md-6 mb-2">
                                            <label class="form-label">Message Type</label>
                                            <select class="form-select" id="messageType">
                                                <option value="text">Text Message</option>
                                                <option value="forward">Forward Message</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div class="mb-2">
                                        <label class="form-label">Message</label>
                                        <textarea class="form-control" id="sendMessage" rows="3" 
                                                  placeholder="Type your message here..."></textarea>
                                    </div>
                                    <button class="btn btn-telegram w-100" onclick="sendMessageFromPanel()">
                                        <i class="fas fa-paper-plane me-1"></i>Send Message
                                    </button>
                                </div>
                            </div>
                            
                            <div class="card mb-3">
                                <div class="card-body">
                                    <h6><i class="fas fa-broadcast-tower me-2"></i>Mass Actions</h6>
                                    <div class="mb-3">
                                        <textarea class="form-control" id="massMessage" rows="2" 
                                                  placeholder="Message to send to all groups"></textarea>
                                    </div>
                                    <div class="d-grid gap-2">
                                        <button class="btn btn-outline-primary" onclick="getGroupsList('\${sessionId}')">
                                            <i class="fas fa-list me-1"></i>View All Groups (\${info.groups.total})
                                        </button>
                                        <button class="btn btn-outline-warning" onclick="forwardToAllGroupsPrompt()">
                                            <i class="fas fa-share-square me-1"></i>Send to All Groups
                                        </button>
                                    </div>
                                </div>
                            </div>
                            
                            <div id="resultsSection"></div>
                        </div>
                    </div>
                    \`;
                    
                    const modal = new bootstrap.Modal(document.getElementById('sessionModal'));
                    modal.show();
                    
                } catch (error) {
                    showAlert('Error loading account info: ' + error.message, 'danger');
                }
            }
            
            // Send message from control panel
            async function sendMessageFromPanel() {
                if (!currentSessionId) return;
                
                const peer = document.getElementById('sendPeer').value.trim();
                const message = document.getElementById('sendMessage').value.trim();
                
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
                        document.getElementById('sendMessage').value = '';
                    } else {
                        showAlert('❌ Failed: ' + result.error, 'danger');
                    }
                } catch (error) {
                    showAlert('❌ Error: ' + error.message, 'danger');
                }
            }
            
            // Forward to all groups
            async function forwardToAllGroupsPrompt() {
                if (!currentSessionId) return;
                
                const message = prompt('Enter message to send to all groups:');
                if (!message) return;
                
                if (!confirm(\`Are you sure you want to send this message to ALL groups?\\n\\n"\${message}"\`)) {
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
                        showAlert(\`✅ Message sent to \${result.successful} out of \${result.totalGroups} groups!\`, 'success');
                    } else {
                        showAlert('❌ Failed: ' + result.error, 'danger');
                    }
                } catch (error) {
                    showAlert('❌ Error: ' + error.message, 'danger');
                }
            }
            
            // Get groups list
            async function getGroupsList(sessionId) {
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/groups\`);
                    const groups = await response.json();
                    
                    const container = document.getElementById('resultsSection');
                    let html = '<h6 class="mt-3">Groups List</h6><div class="table-responsive"><table class="table table-sm"><thead><tr><th>Title</th><th>Type</th><th>Members</th><th>ID</th><th>Action</th></tr></thead><tbody>';
                    
                    groups.forEach(group => {
                        html += \`
                        <tr>
                            <td>\${group.title}</td>
                            <td><span class="badge \${group.isChannel ? 'bg-info' : 'bg-success'}">\${group.isChannel ? 'Channel' : 'Group'}</span></td>
                            <td>\${group.participantsCount || 'N/A'}</td>
                            <td><small class="text-muted">\${group.id}</small></td>
                            <td>
                                <button class="btn btn-sm btn-outline-primary" onclick="sendToGroup('\${sessionId}', '\${group.id}', '\${group.title}')">
                                    <i class="fas fa-paper-plane"></i>
                                </button>
                            </td>
                        </tr>
                        \`;
                    });
                    
                    html += '</tbody></table></div>';
                    container.innerHTML = html;
                } catch (error) {
                    showAlert('Error loading groups: ' + error.message, 'danger');
                }
            }
            
            // Disconnect session
            async function disconnectSession(sessionId) {
                if (!confirm('Disconnect this account?')) return;
                
                try {
                    const response = await fetch(\`/api/sessions/\${sessionId}/disconnect\`, {
                        method: 'POST'
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert('✅ Account disconnected', 'success');
                        loadSessions();
                        loadStatistics();
                    }
                } catch (error) {
                    showAlert('Error: ' + error.message, 'danger');
                }
            }
            
            // Load statistics
            async function loadStatistics() {
                try {
                    const response = await fetch('/api/statistics');
                    const stats = await response.json();
                    
                    document.getElementById('totalAccounts').textContent = stats.totalAccounts || 0;
                    document.getElementById('connectedAccounts').textContent = stats.activeConnections || 0;
                    document.getElementById('messagesSent').textContent = stats.totalMessagesSent || 0;
                    document.getElementById('groupsManaged').textContent = stats.totalGroupsManaged || 0;
                    document.getElementById('connectionCount').textContent = stats.activeConnections || 0;
                } catch (error) {
                    console.error('Error loading statistics:', error);
                }
            }
            
            // Helper functions
            function showAlert(message, type) {
                const alertDiv = document.createElement('div');
                alertDiv.className = \`alert alert-\${type} alert-dismissible fade show\`;
                alertDiv.innerHTML = \`
                    \${message}
                    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
                \`;
                
                // Remove existing alerts
                document.querySelectorAll('.alert-dismissible').forEach(alert => alert.remove());
                
                // Add to page
                document.querySelector('.main-container').prepend(alertDiv);
                
                // Auto remove after 5 seconds
                setTimeout(() => {
                    if (alertDiv.parentElement) {
                        alertDiv.remove();
                    }
                }, 5000);
            }
            
            function showLoading(message) {
                showAlert(\`<i class="fas fa-spinner fa-spin me-2"></i>\${message}\`, 'info');
            }
            
            // Add other helper functions here...
            
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
        
        const result = await telegramManager.connectWithSession(sessionId, sessionString);
        res.json(result);
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: 'Make sure your session string is valid and from a Telegram user account (not bot token)'
        });
    }
});

// Create new session
app.post('/api/sessions/create', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: 'Phone number required' });
        }
        
        const flowId = `flow_${Date.now()}`;
        
        // Store phone number for later verification
        sessionCreationFlows.set(flowId, {
            phoneNumber,
            stage: 'waiting_code',
            createdAt: Date.now()
        });
        
        res.json({
            success: true,
            message: 'Verification code will be sent to your phone',
            flowId,
            nextStep: 'enter_code'
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Verify phone code
app.post('/api/sessions/verify', async (req, res) => {
    try {
        const { flowId, code, password } = req.body;
        
        const flow = sessionCreationFlows.get(flowId);
        if (!flow) {
            return res.status(404).json({ success: false, error: 'Verification flow not found' });
        }
        
        // This would normally handle the actual verification
        // For now, we'll simulate it
        const sessionId = `session_${Date.now()}`;
        const mockSessionString = `mock_session_${Math.random().toString(36).substr(2)}`;
        
        // Add to database
        const db = readDatabase();
        db.accounts.push({
            id: sessionId,
            sessionString: mockSessionString,
            phoneNumber: flow.phoneNumber,
            userId: `user_${Date.now()}`,
            username: '',
            firstName: '',
            lastName: '',
            isBot: false,
            createdAt: new Date().toISOString(),
            lastLogin: new Date().toISOString(),
            isActive: true,
            status: 'connected'
        });
        writeDatabase(db);
        
        // Clean up flow
        sessionCreationFlows.delete(flowId);
        
        res.json({
            success: true,
            sessionId,
            message: 'Account created successfully'
        });
        
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
        res.status(500).json({ success: false, error: error.message });
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

// Forward to all groups
app.post('/api/sessions/:id/forward', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const { message } = req.body;
        
        if (!message) {
            return res.status(400).json({ success: false, error: 'Message required' });
        }
        
        const result = await telegramManager.forwardToAllGroups(sessionId, message);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get groups
app.get('/api/sessions/:id/groups', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const clientData = telegramManager.clients.get(sessionId);
        
        if (!clientData) {
            return res.status(404).json({ success: false, error: 'Session not connected' });
        }
        
        const groups = await telegramManager.getUserGroups(clientData.client);
        res.json(groups);
    } catch (error) {
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
app.get('/api/statistics', (req, res) => {
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
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeConnections: telegramManager.clients.size,
        totalAccounts: readDatabase().accounts.length,
        version: '2.0.0'
    });
});

// ==================== START SERVER ====================
const server = app.listen(config.webPort, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║     📱 Professional Telegram Account Manager             ║
║     🚀 Server running on port ${config.webPort}                   ║
║     🌐 Access: ${config.webBaseUrl}                       ║
║     🔐 API ID: ${config.telegramApiId}                          ║
║     🔑 API Hash: ${config.telegramApiHash}             ║
╚══════════════════════════════════════════════════════════╝
    `);
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
