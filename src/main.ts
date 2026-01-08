import { Plugin, WorkspaceLeaf, TFile, MarkdownView } from 'obsidian';
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

    async onload() {
        console.log('Loading Atomic Sync plugin');

        await this.loadSettings();

        this.addSettingTab(new AtomicSyncSettingTab(this.app, this));

        // Initialize Supabase if settings exist
        if (this.settings.supabaseUrl && this.settings.supabaseKey) {
            this.initSupabase();
        }

        // Register the compartment
        this.registerEditorExtension(this.collabCompartment.of([]));

        // Listen for file opening
        this.registerEvent(
            this.app.workspace.on('file-open', this.handleFileOpen.bind(this))
        );
        
        // Cleanup providers when file is closed/modified externally
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                this.cleanupProvider(file.path);
            })
        );
        
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                this.cleanupProvider(oldPath);
            })
        );
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

            // 1. Connect Persistence (Offline support)
            const persistence = new IndexeddbPersistence(file.path, ydoc);
            
            // Wait for persistence to be ready
            await new Promise<void>((resolve) => {
                if (persistence.synced) {
                    resolve();
                } else {
                    persistence.once('synced', () => resolve());
                }
            });

            // 2. Connect Provider (Cloud support)
            const provider = new SupabaseProvider(ydoc, this.supabase, file.path, this.settings.vaultPassword);
            
            // Wait for provider to be ready
            await new Promise<void>((resolve) => {
                if (provider.isLoaded) {
                    resolve();
                } else {
                    const checkLoaded = setInterval(() => {
                        if (provider.isLoaded) {
                            clearInterval(checkLoaded);
                            resolve();
                        }
                    }, 100);
                }
            });

            this.providers.set(file.path, { provider, persistence, editorView });

            // Only reconfigure if we're still on the same file
            const currentFile = this.app.workspace.getActiveFile();
            if (currentFile?.path === file.path) {
                editorView.dispatch({
                    effects: this.collabCompartment.reconfigure(
                        yCollab(ytext, provider.awareness)
                    )
                });
                console.log(`✅ Sync enabled for ${file.path}`);
            }
        } catch (error) {
            console.error(`❌ Failed to setup sync for ${file.path}:`, error);
        } finally {
            // Remove from pending
            this.pendingConnections.delete(file.path);
        }
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
