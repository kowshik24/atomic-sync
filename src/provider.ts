import * as Y from 'yjs';
import { SupabaseClient } from '@supabase/supabase-js';
import { Awareness } from 'y-protocols/awareness';
import { encrypt, decrypt, deriveKey } from './encryption';

export class SupabaseProvider {
    doc: Y.Doc;
    supabase: SupabaseClient;
    path: string;
    awareness: Awareness;
    channel: any;
    encryptionKey: CryptoKey | null = null;
    isLoaded: boolean = false;
    
    // Debounce updates to avoid flooding Supabase
    private updateQueue: Uint8Array[] = [];
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly DEBOUNCE_MS = 500; // Wait 500ms after last keystroke

    constructor(doc: Y.Doc, supabase: SupabaseClient, path: string, password?: string) {
        this.doc = doc;
        this.supabase = supabase;
        this.path = path;
        this.awareness = new Awareness(doc);

        // Initialize and connect automatically
        if (password) {
            this.initEncryption(password).then(() => {
                this.connect();
            });
        } else {
            console.warn("No password provided, encryption disabled (NOT RECOMMENDED)");
            this.connect();
        }
    }
    
    // Expose a method to check if provider is fully connected
    isConnected(): boolean {
        return this.isLoaded && this.channel !== null;
    }

    async initEncryption(password: string) {
        this.encryptionKey = await deriveKey(password);
    }

    async connect() {
        console.log(`Connecting to Supabase for ${this.path}`);
        await this.sync();
        this.subscribe();

        // Listen for local updates and push them
        this.doc.on('update', this.handleUpdate.bind(this));
    }

    async sync() {
        // 1. Get Document ID
        const { data: docData, error: docError } = await this.supabase
            .from('documents')
            .select('id')
            .eq('path', this.path)
            .maybeSingle();

        if (docError) {
            console.error('Error fetching document:', docError);
            return;
        }

        let docId = docData?.id;

        // If not exists, create it
        if (!docId) {
            const { data: newDoc, error: createError } = await this.supabase
                .from('documents')
                .insert({ path: this.path })
                .select('id')
                .single();

            if (createError) {
                console.error('Error creating document:', createError);
                return;
            }
            docId = newDoc.id;
        }
        
        // Cache the docId for realtime subscription filtering
        this.docIdCached = docId;

        // 2. Fetch Updates
        const { data: updates, error: updatesError } = await this.supabase
            .from('updates')
            .select('update_blob')
            .eq('document_id', docId)
            .order('created_at', { ascending: true });

        if (updatesError) {
            console.error('Error fetching updates:', updatesError);
            return;
        }

        // 3. Apply Updates
        if (updates && updates.length > 0) {
            console.log(`📥 Fetched ${updates.length} updates from Supabase for ${this.path}`);
            // Process and decrypt all updates BEFORE the transaction
            const processedUpdates: Uint8Array[] = [];
            
            for (const row of updates) {
                // The update_blob is stored as a base64 string (see handleUpdate method)
                let blob: Uint8Array;
                
                if (typeof row.update_blob === 'string') {
                    // Decode base64 to binary
                    try {
                        const binaryString = atob(row.update_blob);
                        blob = new Uint8Array(binaryString.length);
                        for (let i = 0; i < binaryString.length; i++) {
                            blob[i] = binaryString.charCodeAt(i);
                        }
                    } catch (e) {
                        console.error("Failed to decode base64 update_blob:", e);
                        continue;
                    }
                } else {
                    // If it's already a Uint8Array or buffer
                    blob = new Uint8Array(row.update_blob);
                }

                if (this.encryptionKey) {
                    // We need the IV. Where did we store it?
                    // Ah, the design said: "update_blob" is the encrypted binary data. 
                    // We need to pack the IV with the data or store it separately.
                    // Common practice: Prepend IV to the cyphertext.
                    // Let's assume the blob is [IV (12 bytes) + DEST (rest)]
                    
                    // Check if blob has enough data for IV
                    if (blob.length < 12) {
                        console.error(`Blob too short for IV: ${blob.length} bytes. Skipping update.`);
                        continue;
                    }
                    
                    const iv = blob.slice(0, 12);
                    const ciphertext = blob.slice(12);
                    
                    if (ciphertext.length === 0) {
                        console.error("Empty ciphertext after extracting IV. Skipping update.");
                        continue;
                    }
                    
                    try {
                        const decrypted = await decrypt(ciphertext, iv, this.encryptionKey);
                        processedUpdates.push(decrypted);
                    } catch (e) {
                        console.error("❌ Decryption failed for an update:", e);
                        console.error(`   - Blob length: ${blob.length}, IV length: ${iv.length}, Ciphertext length: ${ciphertext.length}`);
                        console.error(`   - This may indicate the data was encrypted with a different password or is corrupted`);
                        // Skip this update if decryption fails
                    }
                } else {
                    processedUpdates.push(new Uint8Array(blob));
                }
            }
            
            // Apply all updates in a single synchronous transaction
            if (processedUpdates.length > 0) {
                console.log(`✅ Applying ${processedUpdates.length} decrypted updates for ${this.path}`);
                this.doc.transact(() => {
                    for (const update of processedUpdates) {
                        Y.applyUpdate(this.doc, update);
                    }
                }, 'remote'); // Origin 'remote' to avoid echoing back
            } else {
                console.warn(`⚠️ No valid updates to apply for ${this.path} (${updates.length} fetched, but all failed decryption)`);
            }
        } else {
            console.log(`📭 No updates found in Supabase for ${this.path}`);
            
            // Auto-initialize: If no updates exist in Supabase but Y.Doc has content,
            // push it as the first update
            const currentContent = this.doc.getText('codemirror').toString();
            if (currentContent.length > 0) {
                console.log(`📤 Auto-initializing: Pushing ${currentContent.length} characters to Supabase`);
                // Create a FULL update from the current state (no state vector = full state)
                const update = Y.encodeStateAsUpdate(this.doc);
                
                // Push it to Supabase
                await this.pushUpdate(update);
            }
        }

        this.isLoaded = true;
        console.log(`✅ Sync completed for ${this.path}`);
    }

    async handleUpdate(update: Uint8Array, origin: any) {
        if (origin === 'remote') {
            return; // Don't push back what we just pulled
        }
        
        // Add update to queue
        this.updateQueue.push(update);
        
        // Debounce: wait for typing to stop before pushing
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        
        this.debounceTimer = setTimeout(async () => {
            if (this.updateQueue.length === 0) return;
            
            console.log(`📤 Pushing ${this.updateQueue.length} update(s) for ${this.path}...`);
            
            // Merge all queued updates into one
            const mergedUpdate = Y.mergeUpdates(this.updateQueue);
            this.updateQueue = [];
            
            try {
                await this.pushUpdate(mergedUpdate);
            } catch (e) {
                console.error(`❌ Failed to push update for ${this.path}:`, e);
            }
        }, this.DEBOUNCE_MS);
    }

    async pushUpdate(update: Uint8Array) {
        // 1. Encrypt
        let blobToSend: Uint8Array;
        if (this.encryptionKey) {
            try {
                const { iv, content } = await encrypt(update, this.encryptionKey);
                // Concatenate IV + Content
                blobToSend = new Uint8Array(iv.length + content.length);
                blobToSend.set(iv);
                blobToSend.set(content, iv.length);
            } catch (e) {
                console.error("Encryption failed:", e);
                console.error("Update size:", update.length);
                console.error("Key exists:", !!this.encryptionKey);
                throw e; // Throw to propagate error
            }
        } else {
            blobToSend = update;
        }

        // 2. Push to Supabase
        try {
            // We need the docId. Ideally we cache it.
            const { data: docData, error } = await this.supabase.from('documents').select('id').eq('path', this.path).single();
            if (error || !docData) {
                console.error("Failed to get document ID:", error);
                throw error;
            }

            // Convert Uint8Array to Base64 string for simple, reliable transport
            // We use a helper function to avoid stack overflow with large arrays
            const base64Blob = this.toBase64(blobToSend);

            const { error: insertError } = await this.supabase.from('updates').insert({
                document_id: docData.id,
                update_blob: base64Blob
            });

            if (insertError) {
                console.error("Failed to insert update:", insertError);
                throw insertError;
            } else {
                console.log("✅ Update saved to Supabase");
            }
        } catch (e) {
            console.error("Error pushing update:", e);
            throw e;
        }
    }

    // Force sync: Push current state to Supabase
    async forceSync(): Promise<void> {
        console.log(`🔄 Force syncing ${this.path}...`);
        
        // Create a FULL update (no state vector = full state)
        const update = Y.encodeStateAsUpdate(this.doc);
        const currentContent = this.doc.getText('codemirror').toString();
        
        if (currentContent.length > 0) {
            await this.pushUpdate(update);
            console.log(`✅ Force sync completed for ${this.path} (${currentContent.length} chars)`);
        } else {
            console.log(`⚠️ No content to sync for ${this.path}`);
        }
    }

    subscribe() {
        console.log(`📡 Setting up realtime subscription for ${this.path}`);
        
        this.channel = this.supabase
            .channel(`doc:${this.path}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'updates',
            }, async (payload) => {
                console.log(`📨 Received realtime event for updates table`);
                
                // Check if this update belongs to OUR document
                if (!this.docIdCached) {
                    console.warn(`⚠️ docIdCached not set, fetching...`);
                    const { data } = await this.supabase.from('documents').select('id').eq('path', this.path).single();
                    this.docIdCached = data?.id;
                }

                if (payload.new.document_id !== this.docIdCached) {
                    console.log(`⏭️ Update is for different document, ignoring`);
                    return;
                }

                console.log(`📥 Realtime update received for ${this.path}`);
                
                // It's for us!
                let blob = payload.new.update_blob;

                // DATA IS BASE64 STRING
                let binaryData: Uint8Array;
                try {
                    if (typeof blob !== 'string') {
                        console.warn("Unexpected blob type:", typeof blob);
                        return;
                    }

                    const binaryString = atob(blob);
                    binaryData = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        binaryData[i] = binaryString.charCodeAt(i);
                    }
                } catch (e) {
                    console.error("Failed to decode base64:", e);
                    return;
                }

                // Decrypt and Apply
                if (this.encryptionKey) {
                    try {
                        const iv = binaryData.slice(0, 12);
                        const ciphertext = binaryData.slice(12);
                        const decrypted = await decrypt(ciphertext, iv, this.encryptionKey);
                        Y.applyUpdate(this.doc, decrypted, 'remote');
                        console.log(`✅ Realtime update applied for ${this.path}`);
                    } catch (e) {
                        console.error("❌ Realtime decryption failed:", e);
                    }
                } else {
                    Y.applyUpdate(this.doc, binaryData, 'remote');
                    console.log(`✅ Realtime update applied (unencrypted) for ${this.path}`);
                }
            })
            .subscribe((status) => {
                console.log(`📡 Realtime subscription status for ${this.path}: ${status}`);
                if (status === 'SUBSCRIBED') {
                    console.log(`✅ Realtime connected for ${this.path}`);
                } else if (status === 'CHANNEL_ERROR') {
                    console.error(`❌ Realtime subscription failed for ${this.path}`);
                }
            });
    }

    docIdCached: string | null = null;

    toBase64(bytes: Uint8Array) {
        let binary = '';
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    destroy() {
        // Clear debounce timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        
        // Flush any remaining updates before destroying
        if (this.updateQueue.length > 0) {
            console.log(`⚠️ Flushing ${this.updateQueue.length} pending update(s) for ${this.path}`);
            const mergedUpdate = Y.mergeUpdates(this.updateQueue);
            this.pushUpdate(mergedUpdate).catch(e => console.error('Failed to flush updates:', e));
            this.updateQueue = [];
        }
        
        if (this.channel) this.supabase.removeChannel(this.channel);
        this.awareness.destroy();
        this.doc.destroy();
    }
}
