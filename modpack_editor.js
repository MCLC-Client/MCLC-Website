/**
 * MCLC Web Modpack Editor
 * Logic for Modrinth Integration, State Management, and Export/Import.
 */

// State (moved below elements)

// Elements
const elPackName = document.getElementById('packName');
const elPackVersion = document.getElementById('packVersion');
const elPackLoader = document.getElementById('packLoader');
const elSearchInput = document.getElementById('modSearchInput');
const elSearchResults = document.getElementById('searchResults');
const elResultCount = document.getElementById('searchResultCount');
const elCurrentMods = document.getElementById('currentMods');
const elModCount = document.getElementById('modCount');
const elEmptyState = document.getElementById('emptyPackState');
const elDraftsModal = document.getElementById('draftsModal');
const elDraftsContent = document.getElementById('draftsModalContent');

let MODPACK_STATE = {
    name: '',
    version: '1.20.1',
    loader: 'fabric',
    installedMods: []
};

let currentUser = null;
let trendingMods = [];
let currentPage = 1;
const modsPerPage = 18;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Modpack Editor [v3]: DOM Loaded, Initializing...');
    console.log('Modpack Editor: Current URL:', window.location.href);

    // Safety check for critical elements
    if (!elPackName || !elSearchInput || !elSearchResults) {
        console.error('Modpack Editor: Critical elements missing!', {
            packName: !!elPackName,
            searchInput: !!elSearchInput,
            searchResults: !!elSearchResults
        });
    }

    // Check auth for drafts
    console.log('Modpack Editor: Checking auth state...');
    try {
        const res = await fetch('/api/user');
        if (res.ok) {
            const data = await res.json();
            console.log('Modpack Editor: Auth response:', data);
            if (data.loggedIn) {
                currentUser = data.user;
                // Show 'My Modpacks' button
                const btnMyPacks = document.getElementById('myModpacksBtn');
                if (btnMyPacks) btnMyPacks.classList.remove('hidden');
            }
        }
    } catch (e) {
        console.error('Modpack Editor: Auth check failed', e);
    } finally {
        // Always refresh modal content once auth check is definitively done
        console.log('Modpack Editor: Finalizing draft load (Post-Auth)');
        loadDrafts();
    }

    // Fetch trending mods for empty state
    fetchTrendingMods();

    // Input listeners for state sync
    if (elPackName) elPackName.addEventListener('input', (e) => {
        MODPACK_STATE.name = e.target.value;
        saveDraft();
    });
    if (elPackVersion) elPackVersion.addEventListener('input', (e) => {
        MODPACK_STATE.version = e.target.value;
        if (elSearchInput && elSearchInput.value.trim()) {
            triggerSearch();
        } else {
            fetchTrendingMods();
        }
        saveDraft();
    });
    if (elPackLoader) elPackLoader.addEventListener('change', (e) => {
        MODPACK_STATE.loader = e.target.value;
        if (elSearchInput && elSearchInput.value.trim()) {
            triggerSearch();
        } else {
            fetchTrendingMods();
        }
        saveDraft();
    });

    // Search input listener to show trending when empty
    if (elSearchInput) {
        elSearchInput.addEventListener('input', (e) => {
            if (!e.target.value.trim()) {
                renderSearchResults(trendingMods, true);
            }
        });
    }
});

async function fetchTrendingMods() {
    try {
        const ver = MODPACK_STATE.version;
        const loader = MODPACK_STATE.loader;
        const res = await fetch(`https://api.modrinth.com/v2/search?limit=8&facets=[["categories:${loader}"],["versions:${ver}"],["project_type:mod"]]`);
        if (res.ok) {
            const data = await res.json();
            trendingMods = data.hits || [];
            console.log('Modpack Editor: Trending mods fetched:', trendingMods.length);
            if (elSearchInput && !elSearchInput.value.trim()) {
                renderSearchResults(trendingMods, true);
            }
        } else {
            console.error('Modpack Editor: Modrinth API returned error:', res.status);
        }
    } catch (e) {
        console.warn('Modpack Editor: Failed to fetch trending mods', e);
    }
}

// Modals
function toggleImportModal() {
    const modal = document.getElementById('importModal');
    if (modal) {
        modal.classList.toggle('hidden');
        modal.classList.toggle('flex');
        document.body.classList.toggle('overflow-hidden');
    }
}

function toggleExportModal() {
    const modal = document.getElementById('exportModal');
    if (modal) {
        modal.classList.toggle('hidden');
        modal.classList.toggle('flex');
        document.body.classList.toggle('overflow-hidden');
    }
}

function toggleMyModpacks() {
    const modal = document.getElementById('draftsModal');
    if (modal) {
        modal.classList.toggle('hidden');
        modal.classList.toggle('flex');
        document.body.classList.toggle('overflow-hidden');
        if (modal.classList.contains('flex')) {
            loadDrafts();
        }
    }
}

function copyCode() {
    const el = document.getElementById('exportCodeDisplay');
    if (el && el.innerText !== '--------') {
        navigator.clipboard.writeText(el.innerText).then(() => {
            const originalText = el.innerText;
            el.innerText = 'COPIED!';
            setTimeout(() => {
                if (el.innerText === 'COPIED!') el.innerText = originalText;
            }, 2000);
        }).catch(err => {
            console.error('Failed to copy text: ', err);
        });
    }
}



// Search Logic (Debounced)
let searchTimeout = null;
if (elSearchInput) {
    elSearchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(triggerSearch, 400);
    });
}

function triggerSearch() {
    const query = elSearchInput.value.trim();
    if (!query) {
        renderSearchResults(trendingMods, true);
        return;
    }
    searchModrinth(query);
}

async function searchModrinth(query) {
    const actualResults = document.getElementById('actualSearchResults');
    const suggestContainer = document.getElementById('suggestedModsContainer');

    if (suggestContainer) suggestContainer.classList.add('hidden');
    if (actualResults) {
        actualResults.classList.remove('hidden');
        actualResults.innerHTML = `
            <div class="col-span-full py-20 text-center text-primary h-full flex flex-col items-center justify-center">
                <i class="fas fa-circle-notch fa-spin text-4xl mb-4"></i>
                <p class="font-bold uppercase tracking-widest text-sm text-gray-400">Searching Modrinth...</p>
            </div>
        `;
    }

    try {
        const facets = [
            `["categories:${MODPACK_STATE.loader}"]`,
            `["versions:${MODPACK_STATE.version}"]`,
            `["project_type:mod"]`
        ];

        const params = new URLSearchParams({
            query: query,
            limit: 8,
            index: 'relevance',
            facets: `[${facets.join(',')}]`
        });

        const res = await fetch(`https://api.modrinth.com/v2/search?${params.toString()}`);
        if (!res.ok) throw new Error('Modrinth API Error');
        const data = await res.json();

        elResultCount.innerText = `${data.total_hits} FOUND`;
        renderSearchResults(data.hits);

    } catch (error) {
        console.error('Search error:', error);
        elSearchResults.innerHTML = `
            <div class="col-span-full py-20 text-center text-red-400">
                <i class="fas fa-exclamation-triangle text-4xl mb-4 opacity-50"></i>
                <p class="font-bold">Error communicating with Modrinth.</p>
                <p class="text-sm mt-2 opacity-75">${error.message}</p>
            </div>
        `;
    }
}

// hits: array of mod objects
// isTrending: boolean to change header title
function renderSearchResults(hits, isTrending = false) {
    if (!hits) hits = [];
    const elResultCount = document.getElementById('searchResultCount');
    const actualResults = document.getElementById('actualSearchResults');
    const suggestContainer = document.getElementById('suggestedModsContainer');
    const suggestList = document.getElementById('suggestedModsList');

    if (elResultCount) {
        elResultCount.innerText = isTrending ? 'Suggested Mods' : `${hits.length} FOUND`;
    }

    if (isTrending) {
        if (suggestContainer) suggestContainer.classList.remove('hidden');
        if (actualResults) actualResults.classList.add('hidden');
        if (suggestList) {
            suggestList.innerHTML = '';
            if (hits.length === 0) {
                suggestList.innerHTML = '<p class="col-span-full py-10 text-center text-gray-500">No suggestions available.</p>';
                return;
            }
            hits.forEach(mod => suggestList.appendChild(createModCard(mod)));
        }
    } else {
        if (suggestContainer) suggestContainer.classList.add('hidden');
        if (actualResults) {
            actualResults.classList.remove('hidden');
            actualResults.innerHTML = '';
            if (hits.length === 0) {
                actualResults.innerHTML = `
                    <div class="col-span-full py-20 text-center text-gray-500">
                        <i class="fas fa-ghost text-4xl mb-4 opacity-50"></i>
                        <p class="font-bold">No mods found matching your criteria.</p>
                        <p class="text-xs mt-2 opacity-50 uppercase tracking-widest">Version: ${MODPACK_STATE.version} | Loader: ${MODPACK_STATE.loader}</p>
                    </div>
                `;
                return;
            }
            hits.forEach(mod => actualResults.appendChild(createModCard(mod)));
        }
    }
}

function createModCard(mod) {
    const isAdded = MODPACK_STATE.installedMods.some(m => m.slug === mod.slug);
    const card = document.createElement('div');
    card.className = "bg-[#111] border border-white/5 hover:border-white/10 rounded-3xl p-6 flex flex-col gap-5 transition-all hover:scale-[1.02] shadow-xl";

    const iconUrl = mod.icon_url || 'resources/icon.png';
    const downloads = mod.downloads > 1000000
        ? (mod.downloads / 1000000).toFixed(1) + 'M'
        : (mod.downloads / 1000).toFixed(1) + 'K';

    const buttonHTML = isAdded
        ? `<button disabled class="bg-white/10 text-gray-500 py-3 rounded-2xl text-sm font-black uppercase tracking-widest w-full cursor-not-allowed border border-white/5 flex items-center justify-center gap-2"><i class="fas fa-check-circle"></i> Installed</button>`
        : `<button onclick="addMod('${mod.slug}', '${mod.title.replace(/'/g, "\\'")}', '${iconUrl}', '${mod.project_id}')" class="bg-white/5 hover:bg-white/10 text-white py-3 rounded-2xl text-sm font-black uppercase tracking-widest transition-all w-full border border-white/5 flex items-center justify-center gap-2 group-hover:bg-primary group-hover:text-black group-hover:border-primary"><i class="fas fa-plus-circle"></i> Install</button>`;

    card.innerHTML = `
        <div class="flex gap-4 items-start">
            <img src="${iconUrl}" class="w-16 h-16 rounded-2xl object-cover bg-black/40 shadow-inner flex-shrink-0" alt="${mod.title}">
            <div class="flex-grow min-w-0">
                <h4 class="font-black text-white text-lg leading-tight truncate mb-0.5" title="${mod.title}">${mod.title}</h4>
                <p class="text-xs text-gray-500 font-bold truncate mb-3" title="${mod.author}">${mod.author}</p>
                <div class="flex items-center gap-2 mb-2">
                    <span class="bg-white/5 text-[10px] text-gray-400 px-2 py-0.5 rounded-md font-black uppercase tracking-tighter border border-white/5">Mod</span>
                    <span class="bg-[#0c1a26] text-[#4a90e2] text-[10px] px-2 py-0.5 rounded-md font-black uppercase tracking-tighter border border-[#4a90e2]/20 flex items-center gap-1">
                        <i class="fas fa-chevron-down text-[8px]"></i> ${downloads}
                    </span>
                </div>
            </div>
        </div>
        
        <p class="text-xs text-gray-400 line-clamp-2 min-h-[2.5rem] leading-relaxed opacity-80">
            ${mod.description || 'No description available for this modification.'}
        </p>
        
        <div class="mt-auto pt-2">
            ${buttonHTML}
        </div>
    `;
    return card;
}

// Pack Management
function addMod(slug, name, icon, modrinthId) {
    if (MODPACK_STATE.installedMods.some(m => m.slug === slug)) return;

    MODPACK_STATE.installedMods.push({
        slug,
        name,
        icon,
        modrinthId
        // We do not lock specific mod file versions currently, letting the client resolve the latest for the version
    });

    renderPack();
    triggerSearch(); // Re-render search results to disable the 'Add' button
    saveDraft();
}

function removeMod(slug) {
    MODPACK_STATE.installedMods = MODPACK_STATE.installedMods.filter(m => m.slug !== slug);
    renderPack();
    saveDraft();

    // Quick re-render of search results if visible to re-enable the 'Add' button
    if (elSearchResults.innerHTML.includes(slug)) {
        triggerSearch();
    }
}

function renderPack() {
    if (elModCount) elModCount.innerText = MODPACK_STATE.installedMods.length;

    if (MODPACK_STATE.installedMods.length === 0) {
        if (elEmptyState) elEmptyState.style.display = 'flex';
        elCurrentMods.innerHTML = '';
        if (elEmptyState) elCurrentMods.appendChild(elEmptyState);
        updatePagination();
        return;
    }

    if (elEmptyState) elEmptyState.style.display = 'none';
    elCurrentMods.innerHTML = '';

    // Pagination slicing
    const startIndex = (currentPage - 1) * modsPerPage;
    const paginatedMods = MODPACK_STATE.installedMods.slice(startIndex, startIndex + modsPerPage);

    paginatedMods.forEach(mod => {
        const row = document.createElement('div');
        row.className = "bg-white/5 border border-white/5 rounded-xl p-3 flex items-center justify-between group hover:bg-white/10 transition-colors";

        row.innerHTML = `
            <div class="flex items-center gap-3 overflow-hidden text-left">
                <img src="${mod.icon}" class="w-8 h-8 rounded-lg object-cover bg-surface" alt="${mod.name}">
                <div class="flex flex-col min-w-0">
                    <span class="font-bold text-sm text-white truncate">${mod.name}</span>
                    <span class="text-[10px] text-gray-500 font-bold uppercase">modrinth</span>
                </div>
            </div>
            <button onclick="removeMod('${mod.slug}')" class="text-gray-600 hover:text-red-500 p-2 transition-colors opacity-0 group-hover:opacity-100" title="Remove Mod">
                <i class="fas fa-trash-alt"></i>
            </button>
        `;
        elCurrentMods.appendChild(row);
    });

    updatePagination();
}

function updatePagination() {
    const totalPages = Math.ceil(MODPACK_STATE.installedMods.length / modsPerPage) || 1;
    if (currentPage > totalPages) currentPage = totalPages;

    const elPrev = document.getElementById('prevModPage');
    const elNext = document.getElementById('nextModPage');
    const elCurrent = document.getElementById('currentModPage');
    const elPagination = document.getElementById('modPagination');

    if (elCurrent) elCurrent.innerText = `PAGE ${currentPage} OF ${totalPages}`;
    if (elPrev) elPrev.disabled = currentPage === 1;
    if (elNext) elNext.disabled = currentPage === totalPages;

    if (elPagination) {
        if (MODPACK_STATE.installedMods.length > modsPerPage) {
            elPagination.classList.remove('hidden');
        } else {
            elPagination.classList.add('hidden');
        }
    }
}

function prevPage() {
    if (currentPage > 1) {
        currentPage--;
        renderPack();
    }
}

function nextPage() {
    const totalPages = Math.ceil(MODPACK_STATE.installedMods.length / modsPerPage);
    if (currentPage < totalPages) {
        currentPage++;
        renderPack();
    }
}



function loadDrafts() {
    const drafts = JSON.parse(localStorage.getItem('mclc_modpack_drafts') || '[]');

    if (!elDraftsContent) return;
    elDraftsContent.innerHTML = '';

    if (!currentUser) {
        elDraftsContent.innerHTML = `
            <div class="py-12 text-center">
                <div class="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-6 border border-primary/20">
                    <i class="fas fa-user-lock text-3xl text-primary"></i>
                </div>
                <h4 class="text-xl font-bold text-white mb-2">Login Required</h4>
                <p class="text-gray-400 mb-6">To see your recent modpacks and sync them across devices, please sign in.</p>
                <a href="/auth/google?returnTo=/modpack.html&v=3" class="inline-flex items-center gap-2 bg-primary text-black px-8 py-3 rounded-xl font-bold hover:shadow-[0_0_20px_rgba(27,217,106,0.3)] transition-all">
                    Sign In to MCLC [v3]
                </a>
            </div>
        `;
        return;
    }

    if (drafts.length === 0) {
        elDraftsContent.innerHTML = `
            <div class="py-12 text-center text-gray-500">
                <i class="fas fa-folder-open text-4xl mb-4 opacity-20"></i>
                <p class="font-bold">No drafts found.</p>
                <p class="text-xs uppercase tracking-widest mt-2">Start building a pack to save progress!</p>
            </div>
        `;
        return;
    }

    drafts.slice(0, 5).forEach((draft, idx) => {
        const item = document.createElement('div');
        item.className = "bg-white/5 border border-white/5 hover:border-primary/20 rounded-2xl p-5 flex items-center justify-between cursor-pointer transition-all hover:scale-[1.01] group";
        item.onclick = () => {
            restoreDraft(idx);
            toggleMyModpacks();
        };

        const dateStr = new Date(draft.updatedAt || draft.timestamp).toLocaleDateString();

        item.innerHTML = `
            <div class="flex items-center gap-4">
                <div class="w-12 h-12 bg-black/40 rounded-xl flex items-center justify-center border border-white/5 group-hover:border-primary/20">
                    <i class="fas fa-file-code text-primary/50 group-hover:text-primary transition-colors"></i>
                </div>
                <div>
                    <h5 class="font-bold text-white text-lg">${draft.name || 'Untitled Project'}</h5>
                    <div class="flex items-center gap-3 text-xs text-gray-500 font-bold uppercase tracking-wider">
                        <span>${draft.version}</span>
                        <span class="opacity-30">•</span>
                        <span>${draft.loader}</span>
                        <span class="opacity-30">•</span>
                        <span>${dateStr}</span>
                    </div>
                </div>
            </div>
            <i class="fas fa-chevron-right text-gray-700 group-hover:text-primary transition-colors"></i>
        `;
        elDraftsContent.appendChild(item);
    });
}

// Server Integration
async function exportModpack() {
    if (MODPACK_STATE.installedMods.length === 0) {
        alert("Please add at least one mod to your pack before exporting.");
        return;
    }

    const btn = document.getElementById('exportBtn');
    if (btn) btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving...';

    try {
        // Build payload mimicking client Export Modpack
        const payload = {
            name: MODPACK_STATE.name || 'Web Exported Modpack',
            instanceVersion: MODPACK_STATE.version,
            instanceLoader: MODPACK_STATE.loader,
            mods: MODPACK_STATE.installedMods.map(m => m.slug), // The client uses string slugs in the mods array
            resourcePacks: [],
            shaders: [],
            keybinds: null
        };

        const res = await fetch('/api/codes/save', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error('Server returned ' + res.status);

        const data = await res.json();
        if (data.success && data.code) {
            document.getElementById('exportCodeDisplay').innerText = data.code;
            toggleExportModal();
        } else {
            throw new Error(data.error || 'Unknown error saving modpack');
        }

    } catch (error) {
        console.error('Export error:', error);
        alert('Failed to export modpack: ' + error.message);
    } finally {
        if (btn) btn.innerHTML = '<i class="fas fa-share-nodes"></i> Export Modpack';
    }
}

async function importModpack() {
    const code = document.getElementById('importCodeInput').value.trim();
    if (!code) return;

    const btn = document.getElementById('importSubmitBtn');
    if (btn) btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Loading...';

    try {
        const res = await fetch(`/api/codes/${code}`);
        if (!res.ok) {
            if (res.status === 404) throw new Error('Code not found or expired.');
            throw new Error('Server returned ' + res.status);
        }

        const json = await res.json();
        if (json.success && json.data) {
            const pack = json.data;

            // Rehydrate state
            MODPACK_STATE.name = pack.name === 'Exported Modpack' ? '' : pack.name;
            MODPACK_STATE.version = pack.version || pack.instanceVersion || '1.20.1';
            MODPACK_STATE.loader = pack.loader || pack.instanceLoader || 'fabric';

            // UI Sync
            if (elPackName) elPackName.value = MODPACK_STATE.name;
            if (elPackVersion) elPackVersion.value = MODPACK_STATE.version;
            if (elPackLoader) elPackLoader.value = MODPACK_STATE.loader;

            // Resolve mods
            MODPACK_STATE.installedMods = [];
            const rawMods = pack.mods || [];

            // Normalize IDs for API call - handle both string slugs and mod objects
            const slugsForSearch = rawMods.map(m => {
                if (typeof m === 'object' && m !== null) {
                    return m.projectId || m.slug || null;
                }
                return m;
            }).filter(Boolean);

            if (slugsForSearch.length > 0) {
                // To display nicely, we should fetch info from Modrinth for these slugs
                try {
                    const modrinthRes = await fetch(`https://api.modrinth.com/v2/projects?ids=${JSON.stringify(slugsForSearch)}`);
                    if (modrinthRes.ok) {
                        const projects = await modrinthRes.json();
                        slugsForSearch.forEach(slug => {
                            const p = projects.find(proj => proj.slug === slug || proj.id === slug);
                            if (p) {
                                MODPACK_STATE.installedMods.push({
                                    slug: p.slug,
                                    name: p.title,
                                    icon: p.icon_url || 'resources/icon.png',
                                    modrinthId: p.id
                                });
                            } else {
                                // Check if we have original data in the rawMods for this slug
                                const original = rawMods.find(m => (m.projectId === slug || m.slug === slug || m === slug));
                                if (typeof original === 'object') {
                                    MODPACK_STATE.installedMods.push({
                                        slug: original.slug || original.projectId || slug,
                                        name: original.title || original.name || slug,
                                        icon: original.icon || original.icon_url || 'resources/icon.png',
                                        modrinthId: original.projectId || slug
                                    });
                                } else {
                                    // Fallback
                                    MODPACK_STATE.installedMods.push({
                                        slug,
                                        name: slug,
                                        icon: 'resources/icon.png',
                                        modrinthId: slug
                                    });
                                }
                            }
                        });
                    }
                } catch (e) {
                    console.warn('Failed to resolve mod details from Modrinth', e);
                    // Add via fallback
                    rawMods.forEach(m => {
                        const slug = typeof m === 'object' ? (m.slug || m.projectId) : m;
                        const name = typeof m === 'object' ? (m.title || m.name) : m;
                        const icon = typeof m === 'object' ? (m.icon || m.icon_url) : 'resources/icon.png';
                        MODPACK_STATE.installedMods.push({
                            slug,
                            name,
                            icon,
                            modrinthId: slug
                        });
                    });
                }
            }

            saveDraft(); // Save after successful import
            renderPack();
            toggleImportModal();
            document.getElementById('importCodeInput').value = '';

        } else {
            throw new Error(json.error || 'Failed to load modpack code.');
        }

    } catch (error) {
        console.error('Import error:', error);
        alert('Failed to load modpack: ' + error.message);
    } finally {
        if (btn) btn.innerHTML = 'Load Modpack';
    }
}

function saveDraft() {
    if (!currentUser) return; // Only for logged-in users

    const drafts = JSON.parse(localStorage.getItem('mclc_modpack_drafts') || '[]');

    // Create new draft object
    const currentDraft = {
        name: MODPACK_STATE.name || 'Untitled Pack',
        version: MODPACK_STATE.version,
        loader: MODPACK_STATE.loader,
        mods: MODPACK_STATE.installedMods,
        updatedAt: new Date().toISOString()
    };

    // Remove if already exists (by name or some identifier, but name is simplest for now)
    // Actually, let's just keep the last 5 unique ones by content or name
    const existingIndex = drafts.findIndex(d => d.name === currentDraft.name);
    if (existingIndex > -1) {
        drafts.splice(existingIndex, 1);
    }

    drafts.unshift(currentDraft);

    // Keep only last 5
    if (drafts.length > 5) drafts.pop();

    localStorage.setItem('mclc_modpack_drafts', JSON.stringify(drafts));
    loadDrafts();
}



function restoreDraft(index) {
    const drafts = JSON.parse(localStorage.getItem('mclc_modpack_drafts') || '[]');
    const draft = drafts[index];
    if (!draft) return;

    if (MODPACK_STATE.installedMods.length > 0 && !confirm('Discharge current changes and load this draft?')) {
        return;
    }

    MODPACK_STATE.name = draft.name;
    MODPACK_STATE.version = draft.version;
    MODPACK_STATE.loader = draft.loader;
    MODPACK_STATE.installedMods = draft.mods;

    // UI Sync
    if (elPackName) elPackName.value = MODPACK_STATE.name;
    if (elPackVersion) elPackVersion.value = MODPACK_STATE.version;
    if (elPackLoader) elPackLoader.value = MODPACK_STATE.loader;

    renderPack();
    triggerSearch();
    alert('Draft loaded successfully!');
}
