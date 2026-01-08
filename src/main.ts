import { Plugin, WorkspaceLeaf, TFile, MarkdownView, Notice } from 'obsidian';
import { SupabaseProvider } from './provider';
import { AtomicSyncSettings, DEFAULT_SETTINGS, AtomicSyncSettingTab } from './settings';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as Y from 'yjs';
import { yCollab } from 'y-codemirror.next';
import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { IndexeddbPersistence } from 'y-indexeddb';

export default class AtomicSyncPlugin extends Plugin {
    settings: AtomicSyncSettings;
    supabase: SupabaseClient;
    collabCompartment = new Compartment();
    // Keep track of active connections by file path
    providers = new Map<string, { provider: SupabaseProvider, persistence: IndexeddbPersistence, editorView: EditorView }>();
    // Track pending connections to prevent duplicates
    pendingConnections = new Set<string>();
    // Background sync interval
    syncInterval: number | null = null;

    async onload() {
        console.log('Loading Atomic Sync plugin');

        await this.loadSettings();

        this.addSettingTab(new AtomicSyncSettingTab(this.app, this));

        // Initialize Supabase if settings exist
        if (this.settings.supabaseUrl && this.settings.supabaseKey) {
            this.initSupabase();
        }

        // Add force-sync command
        this.addCommand({
            id: 'force-sync-current-file',
            name: 'Force sync current file',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (file) {
                    if (!checking) {
                        this.forceSyncCurrentFile();
                    }
                    return true;
                }
                return false;
            }
        });

        // Add sync all files command
        this.addCommand({
            id: 'sync-all-files',
            name: 'Sync all files from Supabase',
            callback: () => {
                this.discoverAndSyncFiles(true);
            }
        });

        // Add cleanup empty documents command
        this.addCommand({
            id: 'cleanup-empty-documents',
            name: 'Clean up empty documents from Supabase',
            callback: async () => {
                await this.cleanupEmptyDocuments();
            }
        });

        // Register the compartment
        this.registerEditorExtension(this.collabCompartment.of([]));

        // Listen for file opening
        this.registerEvent(
            this.app.workspace.on('file-open', this.handleFileOpen.bind(this))
        );
        
        // Cleanup providers when file is closed/modified externally
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile) {
                    this.cleanupProvider(file.path);
                }
            })
        );
        
        this.registerEvent(
            this.app.vault.on('rename', async (file, oldPath) => {
                if (file instanceof TFile) {
                    await this.handleFileRename(file, oldPath);
                }
            })
        );

        // Start background sync if Supabase is initialized
        if (this.supabase) {
            // Initial sync on startup
            this.discoverAndSyncFiles(false);
            
            // Background sync every 60 seconds
            this.syncInterval = window.setInterval(() => {
                this.discoverAndSyncFiles(false);
            }, 60000); // 60 seconds
            
            this.registerInterval(this.syncInterval);
            console.log('🔄 Background file sync enabled (every 60 seconds)');
        }
    }

    initSupabase() {
        if (!this.settings.supabaseUrl || !this.settings.supabaseKey) {
            console.log("Supabase credentials not configured yet");
            return;
        }
        try {
            this.supabase = createClient(this.settings.supabaseUrl, this.settings.supabaseKey);
            console.log("Supabase client initialized successfully");
        } catch (e) {
            console.error("Failed to init Supabase client", e);
        }
    }

    async handleFileOpen(file: TFile | null) {
        if (!file) return;
        
        // Prevent duplicate connections for the same file
        if (this.pendingConnections.has(file.path)) {
            console.log(`⏳ Connection already pending for ${file.path}, skipping...`);
            return;
        }
        
        // Check if we already have a provider for this file
        const existing = this.providers.get(file.path);
        if (existing) {
            console.log(`✅ Reusing existing connection for ${file.path}`);
            return;
        }

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;

        const editorView = (view.editor as any).cm as EditorView;
        if (!editorView) return;

        if (!this.supabase || !this.settings.vaultPassword) return;

        // Mark as pending
        this.pendingConnections.add(file.path);
        
        try {
            console.log(`🔄 Setting up sync for ${file.path}`);
            
            // Initialize Yjs
            const ydoc = new Y.Doc();
            const ytext = ydoc.getText('codemirror');

            // Get current file content from vault (not editor, as editor may not be loaded yet)
            const fileContent = await this.app.vault.read(file);
            console.log(`📄 File content from vault: ${fileContent.length} characters`);

            // 1. Connect Persistence (Offline support)
            const persistence = new IndexeddbPersistence(file.path, ydoc);
            
            // Wait for persistence to be ready
            await new Promise<void>((resolve) => {
                if (persistence.synced) {
                    resolve();
                } else {
                    persistence.once('synced', () => {
                        console.log(`💾 IndexedDB synced for ${file.path}`);
                        resolve();
                    });
                }
            });

            // Check if Y.Doc is empty after IndexedDB sync
            const ydocContentAfterIDB = ytext.toString();
            console.log(`📄 Y.Doc content after IndexedDB: ${ydocContentAfterIDB.length} characters`);

            // If Y.Doc is empty but file has content, initialize Y.Doc with file content
            if (ydocContentAfterIDB.length === 0 && fileContent.length > 0) {
                console.log(`📝 Initializing Y.Doc with file content (${fileContent.length} chars)`);
                ytext.insert(0, fileContent);
            }

            // 2. Connect Provider (Cloud support)
            const provider = new SupabaseProvider(ydoc, this.supabase, file.path, this.settings.vaultPassword);
            
            // Wait for provider to be ready (with timeout)
            await new Promise<void>((resolve) => {
                if (provider.isLoaded) {
                    resolve();
                } else {
                    let attempts = 0;
                    const maxAttempts = 100; // 10 seconds max
                    const checkLoaded = setInterval(() => {
                        attempts++;
                        if (provider.isLoaded) {
                            clearInterval(checkLoaded);
                            resolve();
                        } else if (attempts >= maxAttempts) {
                            console.warn(`⚠️ Provider loading timed out for ${file.path}`);
                            clearInterval(checkLoaded);
                            resolve(); // Continue anyway
                        }
                    }, 100);
                }
            });

            const finalContent = ytext.toString();
            console.log(`📄 Final Y.Doc content after sync: ${finalContent.length} characters`);

            this.providers.set(file.path, { provider, persistence, editorView });

            // Only reconfigure if we're still on the same file
            const currentFile = this.app.workspace.getActiveFile();
            if (currentFile?.path === file.path) {
                // First, sync Y.Doc content to editor if they differ
                const currentEditorContent = editorView.state.doc.toString();
                if (finalContent.length > 0 && currentEditorContent !== finalContent) {
                    console.log(`📝 Syncing Y.Doc content (${finalContent.length} chars) to editor (currently ${currentEditorContent.length} chars)`);
                    editorView.dispatch({
                        changes: {
                            from: 0,
                            to: editorView.state.doc.length,
                            insert: finalContent
                        }
                    });
                }
                
                // Then configure yCollab
                editorView.dispatch({
                    effects: this.collabCompartment.reconfigure(
                        yCollab(ytext, provider.awareness)
                    )
                });
                console.log(`✅ Sync enabled for ${file.path}`);
                
                // Show status notification
                new Notice(`✅ ${file.name} - Sync enabled`, 2000);
            }
        } catch (error) {
            console.error(`❌ Failed to setup sync for ${file.path}:`, error);
        } finally {
            // Remove from pending
            this.pendingConnections.delete(file.path);
        }
    }

    async forceSyncCurrentFile() {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            new Notice('❌ No active file to sync');
            return;
        }

        const provider = this.providers.get(file.path);
        if (!provider) {
            new Notice('❌ File is not connected to sync');
            return;
        }

        try {
            new Notice(`🔄 Force syncing ${file.name}...`);
            await provider.provider.forceSync();
            new Notice(`✅ Successfully synced ${file.name}`);
        } catch (error) {
            console.error('Force sync failed:', error);
            new Notice(`❌ Failed to sync ${file.name}`);
        }
    }

    async fetchFileContent(filePath: string): Promise<string> {
        try {
            // Get document ID
            const { data: docData, error: docError } = await this.supabase
                .from('documents')
                .select('id')
                .eq('path', filePath)
                .maybeSingle();

            if (docError || !docData) {
                console.log(`No document found in Supabase for ${filePath}`);
                return '';
            }

            // Fetch updates
            const { data: updates, error: updatesError } = await this.supabase
                .from('updates')
                .select('update_blob')
                .eq('document_id', docData.id)
                .order('created_at', { ascending: true });

            if (updatesError || !updates || updates.length === 0) {
                console.log(`No updates found for ${filePath}`);
                return '';
            }

            console.log(`Fetching ${updates.length} updates for ${filePath}`);

            // Create temporary Y.Doc to reconstruct content
            const tempDoc = new Y.Doc();
            const tempText = tempDoc.getText('codemirror');

            // Derive encryption key
            const encryptionKey = await this.deriveEncryptionKey();
            if (!encryptionKey) {
                console.error('No encryption key available');
                return '';
            }

            // Process and apply updates
            for (const row of updates) {
                try {
                    // Decode base64
                    let blob: Uint8Array;
                    if (typeof row.update_blob === 'string') {
                        const binaryString = atob(row.update_blob);
                        blob = new Uint8Array(binaryString.length);
                        for (let i = 0; i < binaryString.length; i++) {
                            blob[i] = binaryString.charCodeAt(i);
                        }
                    } else {
                        blob = new Uint8Array(row.update_blob);
                    }

                    // Decrypt
                    if (blob.length < 12) continue;
                    
                    const iv = blob.slice(0, 12);
                    const ciphertext = blob.slice(12);
                    
                    // Import decrypt function
                    const { decrypt } = await import('./encryption');
                    const decrypted = await decrypt(ciphertext, iv, encryptionKey);
                    
                    // Apply update
                    Y.applyUpdate(tempDoc, decrypted);
                } catch (e) {
                    console.error('Failed to process update:', e);
                }
            }

            // Extract text content
            const content = tempText.toString();
            console.log(`Extracted ${content.length} characters from ${filePath}`);
            
            return content;
        } catch (error) {
            console.error(`Error fetching content for ${filePath}:`, error);
            return '';
        }
    }

    async deriveEncryptionKey(): Promise<CryptoKey | null> {
        if (!this.settings.vaultPassword) {
            return null;
        }
        
        const { deriveKey } = await import('./encryption');
        return await deriveKey(this.settings.vaultPassword);
    }

    async cleanupEmptyDocuments() {
        if (!this.supabase) {
            new Notice('❌ Supabase not initialized');
            return;
        }

        try {
            console.log('🧹 Cleaning up empty documents from Supabase...');
            new Notice('🧹 Scanning for empty documents...');

            // Fetch all documents
            const { data: documents, error: docError } = await this.supabase
                .from('documents')
                .select('id, path');

            if (docError || !documents) {
                console.error('Failed to fetch documents:', docError);
                new Notice('❌ Failed to fetch documents');
                return;
            }

            let deletedCount = 0;

            // Check each document for updates
            for (const doc of documents) {
                const { data: updates, error: updateError } = await this.supabase
                    .from('updates')
                    .select('id')
                    .eq('document_id', doc.id)
                    .limit(1);

                if (updateError) {
                    console.error(`Error checking updates for ${doc.path}:`, updateError);
                    continue;
                }

                // If no updates, delete the document
                if (!updates || updates.length === 0) {
                    console.log(`🗑️ Deleting empty document: ${doc.path}`);
                    
                    const { error: deleteError } = await this.supabase
                        .from('documents')
                        .delete()
                        .eq('id', doc.id);

                    if (deleteError) {
                        console.error(`Failed to delete ${doc.path}:`, deleteError);
                    } else {
                        deletedCount++;
                    }
                }
            }

            console.log(`✅ Cleanup complete: deleted ${deletedCount} empty document(s)`);
            new Notice(`✅ Deleted ${deletedCount} empty document(s)`);
        } catch (error) {
            console.error('Error during cleanup:', error);
            new Notice('❌ Cleanup failed');
        }
    }

    async discoverAndSyncFiles(showNotification = true) {
        if (!this.supabase) {
            console.log('Supabase not initialized');
            return;
        }

        try {
            console.log('🔍 Discovering files from Supabase...');
            
            // Fetch all documents from Supabase
            const { data: documents, error } = await this.supabase
                .from('documents')
                .select('path')
                .order('last_updated', { ascending: false });

            if (error) {
                console.error('Failed to fetch documents:', error);
                if (showNotification) {
                    new Notice('❌ Failed to discover files from Supabase');
                }
                return;
            }

            if (!documents || documents.length === 0) {
                console.log('No documents found in Supabase');
                return;
            }

            console.log(`Found ${documents.length} documents in Supabase`);

            let createdCount = 0;
            const newFiles: string[] = [];

            // Check each document and create if missing
            for (const doc of documents) {
                const filePath = doc.path;
                
                // Check if file exists locally
                const file = this.app.vault.getAbstractFileByPath(filePath);
                
                if (!file) {
                    // File doesn't exist locally, create it with content from Supabase
                    try {
                        console.log(`📥 Checking file: ${filePath}`);
                        
                        // Fetch content from Supabase
                        const content = await this.fetchFileContent(filePath);
                        
                        // Skip empty files (orphaned/temporary files with no content)
                        if (content.length === 0) {
                            console.log(`⏭️ Skipping empty file: ${filePath}`);
                            continue;
                        }
                        
                        console.log(`📥 Creating file: ${filePath}`);
                        
                        // Create the file with the fetched content
                        await this.app.vault.create(filePath, content);
                        
                        createdCount++;
                        newFiles.push(filePath);
                        console.log(`  ✓ Created with ${content.length} characters`);
                    } catch (createError) {
                        console.error(`Failed to create file ${filePath}:`, createError);
                    }
                }
            }

            if (createdCount > 0) {
                console.log(`✅ Created ${createdCount} new file(s)`);
                if (showNotification) {
                    new Notice(`📥 Synced ${createdCount} new file(s) from Supabase`);
                    // List the files in console
                    newFiles.forEach(file => console.log(`  - ${file}`));
                }
            } else {
                console.log('✅ All files are up to date');
                if (showNotification) {
                    new Notice('✅ All files are in sync');
                }
            }
        } catch (error) {
            console.error('Error discovering files:', error);
            if (showNotification) {
                new Notice('❌ Error discovering files');
            }
        }
    }

    async handleFileRename(file: TFile, oldPath: string) {
        console.log(`📝 File renamed: ${oldPath} → ${file.path}`);
        
        // Cleanup old provider
        this.cleanupProvider(oldPath);
        
        // Update path in Supabase
        if (this.supabase) {
            try {
                const { data: docData, error: findError } = await this.supabase
                    .from('documents')
                    .select('id')
                    .eq('path', oldPath)
                    .maybeSingle();
                
                if (findError) {
                    console.error('Error finding document for rename:', findError);
                    return;
                }
                
                if (docData) {
                    // Update the path in the documents table
                    const { error: updateError } = await this.supabase
                        .from('documents')
                        .update({ path: file.path })
                        .eq('id', docData.id);
                    
                    if (updateError) {
                        console.error('Error updating document path:', updateError);
                    } else {
                        console.log(`✅ Updated document path in Supabase: ${oldPath} → ${file.path}`);
                    }
                } else {
                    console.log(`No document found in Supabase for ${oldPath}`);
                }
            } catch (error) {
                console.error('Error handling rename in Supabase:', error);
            }
        }
        
        // Open the file to trigger sync with new path
        // (This happens automatically if the file is currently open)
    }

    cleanupProvider(filePath: string) {
        const existing = this.providers.get(filePath);
        if (existing) {
            console.log(`🧹 Cleaning up provider for ${filePath}`);
            existing.provider.destroy();
            existing.persistence.destroy();
            this.providers.delete(filePath);
        }
    }

    onunload() {
        console.log('Unloading Atomic Sync plugin');
        
        // Stop background sync
        if (this.syncInterval) {
            window.clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        
        // Cleanup all providers
        for (const [path, { provider, persistence }] of this.providers.entries()) {
            console.log(`Cleaning up provider for ${path}`);
            provider.destroy();
            persistence.destroy();
        }
        this.providers.clear();
        this.pendingConnections.clear();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.initSupabase();
    }
}
