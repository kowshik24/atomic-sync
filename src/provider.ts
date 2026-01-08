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
            this.doc.transact(() => {
                for (const update of processedUpdates) {
                    Y.applyUpdate(this.doc, update);
                }
            }, 'remote'); // Origin 'remote' to avoid echoing back
        }

        this.isLoaded = true;
    }

    async handleUpdate(update: Uint8Array, origin: any) {
        if (origin === 'remote') return; // Don't push back what we just pulled

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
                return; // Don't send if encryption fails
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
                return;
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
            } else {
                console.log("✅ Update saved to Supabase");
            }
        } catch (e) {
            console.error("Error in handleUpdate:", e);
        }
    }

    subscribe() {
        this.channel = this.supabase
            .channel(`doc:${this.path}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'updates',
                // filter: `document_id=eq.${docId}` // Hard to get docId here cleanly without waiting. 
                // We can filter by verifying the document path via a join, but Realtime doesn't do joins.
                // Instead, we will fetch the new row, check if it belongs to our doc (we can cache docId).
            }, async (payload) => {
                // We need to check if this update belongs to OUR document.
                // The payload contains the new row.
                // But the row only has `document_id`.

                // Optimization: Store docId in class property.
                if (!this.docIdCached) {
                    const { data } = await this.supabase.from('documents').select('id').eq('path', this.path).single();
                    this.docIdCached = data?.id;
                }

                if (payload.new.document_id !== this.docIdCached) return;

                // It's for us!
                let blob = payload.new.update_blob;

                // DATA IS BASE64 STRING
                let binaryData: Uint8Array;
                try {
                    // Check if it's already a string (Supabase returns text column as string)
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
                        console.log("✅ Realtime update applied");
                    } catch (e) {
                        console.error("❌ Realtime decryption failed:", e);
                    }
                }

            })
            .subscribe();
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
        if (this.channel) this.supabase.removeChannel(this.channel);
        this.awareness.destroy();
        this.doc.destroy();
    }
}
