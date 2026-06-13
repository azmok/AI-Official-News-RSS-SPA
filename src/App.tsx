import { useState, useEffect, FormEvent } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { 
  Plus, Trash2, Play, RefreshCw, AlertTriangle, CheckCircle, 
  X, Lock, LogOut, Rss, Link, Globe, Settings, Mail, 
  FileText, Layout, ExternalLink, Code, Edit3, Server, 
  User as UserIcon, Loader2, Sparkles, Terminal, BellRing, ChevronRight,
  Clock
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase client
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

interface BlogSource {
  id: string;
  name: string;
  type: 'rss' | 'sitemap' | 'scrape';
  pageUrl: string;
  feedUrl: string | null;
  selector: string | null;
  enabled: boolean;
  consecutiveEmptyCount: number;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [firebaseReady, setFirebaseReady] = useState(false);
  const [sources, setSources] = useState<BlogSource[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  
  // Dashboard form status
  const [newSourceName, setNewSourceName] = useState('');
  const [newSourceUrl, setNewSourceUrl] = useState('');
  const [newSourceSelector, setNewSourceSelector] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [addDiscoveryResult, setAddDiscoveryResult] = useState<{ type: 'rss'|'sitemap'|'scrape'; feedUrl: string|null } | null>(null);
  const [detectingType, setDetectingType] = useState(false);

  // Selector edits
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingSelectorText, setEditingSelectorText] = useState('');

  // Bulk actions status
  const [isChecking, setIsChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{
    message: string;
    newArticlesCount: number;
    newArticles: Array<{ sourceName: string; title: string; url: string }>;
    healthAlertsDispatched: number;
    timestamp: string;
  } | null>(null);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'articles' | 'sources' | 'scheduler' | 'diagnostics'>('articles');
  const [diagnoseResult, setDiagnoseResult] = useState<any | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Feed Reader state variables
  const [recentArticles, setRecentArticles] = useState<Array<{ id: string; sourceId: string; url: string; title: string; description?: string; firstSeenAt: string }>>([]);
  const [loadingArticles, setLoadingArticles] = useState(false);
  const [selectedFeedSourceId, setSelectedFeedSourceId] = useState<string>('all');
  const [readArticleUrls, setReadArticleUrls] = useState<string[]>([]);

  // Monitor Auth Changes and Load Visited Cache
  useEffect(() => {
    // Load local visited cache
    try {
      const saved = localStorage.getItem('visited_articles');
      if (saved) {
        setReadArticleUrls(JSON.parse(saved));
      }
    } catch (err) {
      console.error('Error loading visited articles status:', err);
    }

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setFirebaseReady(true);
      if (u && u.email === 'gentakanashi0425@gmail.com') {
        fetchSources(u);
        fetchRecentArticles(u);
      }
    });
    return () => unsubscribe();
  }, []);

  // API helper with active bearer tokens
  async function apiFetch(currentUser: User, endpoint: string, options: RequestInit = {}) {
    const idToken = await currentUser.getIdToken(true);
    const headers = {
      ...(options.headers || {}),
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json'
    } as any;

    const res = await fetch(endpoint, {
      ...options,
      headers
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: 'Transaction failed' }));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // System Diagnostics trigger
  async function handleDiagnose() {
    if (!user) return;
    setDiagnosing(true);
    setDiagnoseResult(null);
    setErrorMessage(null);
    try {
      const data = await apiFetch(user, '/api/admin/diagnose');
      setDiagnoseResult(data);
      setSuccessMessage('System diagnostic complete. Inspect live authorization parameters below.');
    } catch (err: any) {
      setErrorMessage(err.message || 'System diagnostics failure.');
    } finally {
      setDiagnosing(false);
    }
  }

  // Load blog sources
  async function fetchSources(currentUser: User) {
    setLoadingSources(true);
    setErrorMessage(null);
    try {
      const data = await apiFetch(currentUser, '/api/sources');
      setSources(data);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to load channels config');
    } finally {
      setLoadingSources(false);
    }
  }

  // Load recent articles
  async function fetchRecentArticles(currentUser: User) {
    setLoadingArticles(true);
    try {
      const data = await apiFetch(currentUser, '/api/articles');
      setRecentArticles(data);
    } catch (err: any) {
      console.error('Failed to load recent articles:', err);
    } finally {
      setLoadingArticles(false);
    }
  }

  // Mark article as read (save as visited)
  function handleMarkAsRead(url: string) {
    const normalized = url.trim();
    if (!readArticleUrls.includes(normalized)) {
      const updated = [...readArticleUrls, normalized];
      setReadArticleUrls(updated);
      try {
        localStorage.setItem('visited_articles', JSON.stringify(updated));
      } catch (err) {
        console.error('Error saving visited articles status:', err);
      }
    }
  }

  // Login handler
  async function handleLogin() {
    try {
      setErrorMessage(null);
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      setErrorMessage(err.message || 'Google Auth dialog was closed or blocked.');
    }
  }

  // Logout handler
  async function handleLogout() {
    await signOut(auth);
    setSources([]);
    setCheckResult(null);
  }

  // Dynamic Type Discovery during page input
  async function handleUrlInputBlur() {
    if (!newSourceUrl || !user) return;
    try {
      new URL(newSourceUrl); // Validate format first
    } catch {
      setErrorMessage('Please type a valid absolute page URL (e.g., https://openai.com/news/)');
      return;
    }

    setDetectingType(true);
    setAddDiscoveryResult(null);
    try {
      // Simulate/trigger discovery flow
      const response = await fetch(`/api/sources`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${await user.getIdToken()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'TEMPORARY', pageUrl: newSourceUrl })
      });
      
      const resData = await response.json();
      if (response.ok) {
        // Discovery worked, let's delete that temporary dummy node
        if (resData.id) {
          await fetch(`/api/sources/${resData.id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${await user.getIdToken()}` }
          });
        }
        setAddDiscoveryResult({
          type: resData.type,
          feedUrl: resData.feedUrl
        });
        
        // Auto-populate name if empty
        if (!newSourceName) {
          try {
            const host = new URL(newSourceUrl).hostname.replace('www.', '');
            const cleanName = host.split('.')[0].toUpperCase() + ' News';
            setNewSourceName(cleanName);
          } catch {}
        }
      }
    } catch (err) {
      // ignore discovery failures, user handles manually
    } finally {
      setDetectingType(false);
    }
  }

  // Add source handler
  async function handleAddSource(e: FormEvent) {
    e.preventDefault();
    if (!newSourceName || !newSourceUrl || !user) return;

    setIsAdding(true);
    setErrorMessage(null);
    try {
      const added = await apiFetch(user, '/api/sources', {
        method: 'POST',
        body: JSON.stringify({
          name: newSourceName,
          pageUrl: newSourceUrl,
          selector: newSourceSelector || null
        })
      });
      setSuccessMessage(`Successfully registered: "${added.name}" via ${added.type.toUpperCase()}`);
      
      // Clear fields
      setNewSourceName('');
      setNewSourceUrl('');
      setNewSourceSelector('');
      setAddDiscoveryResult(null);
      
      fetchSources(user);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to submit blog source');
    } finally {
      setIsAdding(false);
    }
  }

  // Toggle enabled checkbox
  async function handleToggleEnabled(source: BlogSource) {
    if (!user) return;
    try {
      await apiFetch(user, `/api/sources/${source.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !source.enabled })
      });
      setSources(prev => prev.map(s => s.id === source.id ? { ...s, enabled: !s.enabled } : s));
    } catch (err: any) {
      setErrorMessage(err.message || 'Toggle failed');
    }
  }

  // Delete source handler
  async function handleDeleteSource(id: string) {
    if (!user) return;
    setErrorMessage(null);
    try {
      await apiFetch(user, `/api/sources/${id}`, { method: 'DELETE' });
      setSources(prev => prev.filter(s => s.id !== id));
      setSuccessMessage('Source deleted successfully.');
    } catch (err: any) {
      setErrorMessage(err.message);
    }
  }

  // Inline CSS selector update save
  async function handleSaveSelector(id: string) {
    if (!user) return;
    try {
      await apiFetch(user, `/api/sources/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ selector: editingSelectorText || null })
      });
      setSources(prev => prev.map(s => s.id === id ? { ...s, selector: editingSelectorText || null } : s));
      setEditingId(null);
      setSuccessMessage('CSS selector updated correctly.');
    } catch (err: any) {
      setErrorMessage(err.message);
    }
  }

  // Re-seed original blogs database
  async function handleReSeed() {
    if (!user || !confirm('Discard current blog configuration list and restore original seed blogs?')) return;
    setLoadingSources(true);
    setErrorMessage(null);
    try {
      await apiFetch(user, '/api/sources/seed', { method: 'POST' });
      await fetchSources(user);
      setSuccessMessage('Database configuration restored successfully.');
    } catch (err: any) {
      setErrorMessage(err.message);
    } finally {
      setLoadingSources(false);
    }
  }

  // Force Sweep Manual Investigation
  async function handleRunCheck() {
    if (!user) return;
    setIsChecking(true);
    setCheckResult(null);
    setErrorMessage(null);
    try {
      const result = await apiFetch(user, '/api/check', { method: 'POST' });
      setCheckResult(result);
      fetchSources(user);
      fetchRecentArticles(user);
    } catch (err: any) {
      setErrorMessage(err.message || 'Periodic audit failed to run.');
    } finally {
      setIsChecking(false);
    }
  }

  // Format checked duration
  function formatLastCheck(isoStr: string | null) {
    if (!isoStr) return 'Never checked';
    const date = new Date(isoStr);
    return date.toLocaleString('ja-JP', { hour12: false });
  }

  if (!firebaseReady) {
    return (
      <div className="min-h-screen bg-bento-bg flex flex-col justify-center items-center text-bento-bright font-sans p-6">
        <Loader2 className="w-12 h-12 text-bento-accent animate-spin mb-4" />
        <h2 className="text-xl font-medium tracking-tight text-bento-bright">Accessing Database Core...</h2>
      </div>
    );
  }

  // USER ACCESS CHECK
  const isAuthorized = user && user.email === 'gentakanashi0425@gmail.com';

  return (
    <div className="min-h-screen bg-bento-bg text-bento-bright font-sans flex flex-col antialiased">
      {/* Header Bar */}
      <header className="border-b border-bento-border bg-bento-card/50 backdrop-blur-md sticky top-0 z-50 px-6 py-4 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-bento-accent text-bento-bg font-black rounded-lg flex items-center justify-center text-xl select-none shadow-[0_0_12px_rgba(63,185,80,0.25)]">
            A
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
              AI Blog Update Notifier
              <span className="text-[10px] uppercase font-mono tracking-wider font-semibold text-bento-accent bg-bento-accent/10 px-2 py-0.5 rounded border border-bento-accent/20">v2.4.0-stable</span>
            </h1>
            <p className="text-xs text-bento-dim">Zero-Trust Personal Publisher Monitor</p>
          </div>
        </div>

        {user && (
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-bento-bg/80 rounded-lg border border-bento-border shadow-inner">
              {user.photoURL ? (
                <img src={user.photoURL} alt="user" className="w-6 h-6 rounded-full border-2 border-bento-accent" referrerPolicy="no-referrer" />
              ) : (
                <UserIcon className="w-4 h-4 text-bento-dim" />
              )}
              <span className="text-sm font-medium text-bento-bright max-w-[120px] truncate sm:max-w-none">{user.email}</span>
            </div>
            <button 
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-bento-error hover:text-white bg-bento-error/10 hover:bg-bento-error border border-bento-error/20 hover:border-transparent rounded-lg transition-all duration-200"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out
            </button>
          </div>
        )}
      </header>

      {/* Main Body Grid */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 flex flex-col gap-6">
        
        {/* Banner Alert for feedback / status */}
        <AnimatePresence>
          {errorMessage && (
            <motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="p-4 bg-bento-card border border-bento-error/30 rounded-xl flex gap-3 text-sm text-bento-bright items-start shadow-lg"
            >
              <AlertTriangle className="w-5 h-5 text-bento-error flex-shrink-0" />
              <div className="flex-1">
                <span className="font-semibold block mb-0.5 text-bento-error">Operation failed:</span>
                <p className="font-mono text-xs text-bento-dim break-words">{errorMessage}</p>
              </div>
              <button onClick={() => setErrorMessage(null)} className="p-0.5 hover:bg-bento-error/20 rounded text-bento-dim hover:text-bento-bright transition-colors">
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          )}

          {successMessage && (
            <motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="p-4 bg-bento-card border border-bento-accent/30 rounded-xl flex gap-3 text-sm text-bento-bright items-start shadow-lg"
            >
              <CheckCircle className="w-5 h-5 text-bento-accent flex-shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-bento-bright">{successMessage}</p>
              </div>
              <button onClick={() => setSuccessMessage(null)} className="p-0.5 hover:bg-bento-accent/20 rounded text-bento-dim hover:text-bento-bright transition-colors">
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 1. LOGIN SCREEN */}
        {!user && (
          <div className="m-auto max-w-md w-full flex flex-col items-center justify-center py-16 px-6">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="w-full bg-bento-card border border-bento-border rounded-2xl p-8 shadow-2xl text-center flex flex-col items-center gap-6"
            >
              <div className="w-16 h-16 bg-bento-accent/10 border border-bento-accent/20 text-bento-accent rounded-2xl flex items-center justify-center shadow-inner">
                <Lock className="w-8 h-8" />
              </div>
              
              <div>
                <h2 className="text-2xl font-bold text-white tracking-tight">Admin Gate Entry Required</h2>
                <p className="text-sm text-bento-dim mt-2">
                  This system monitors AI research publications and dispatches daily digests. Sign in to load database controls.
                </p>
              </div>

              <button 
                onClick={handleLogin}
                className="w-full py-3.5 px-4 bg-bento-accent text-bento-bg font-bold rounded-xl flex items-center justify-center gap-3 active:scale-[0.98] transition-all shadow-[0_4px_20px_rgba(63,185,80,0.2)] hover:bg-opacity-90 max-w-xs"
              >
                <Globe className="w-5 h-5 text-bento-bg" />
                Sign In with Google Account
              </button>

              <div className="text-xs text-bento-dim mt-2 flex flex-col gap-1 items-center font-mono">
                <span>Authorized administrator match key:</span>
                <span className="text-bento-accent bg-bento-accent/10 px-2 py-0.5 rounded border border-bento-accent/20">gentakanashi0425@gmail.com</span>
              </div>
            </motion.div>
          </div>
        )}

        {/* 2. ACCESS DENIED SCREEN (For other emails) */}
        {user && !isAuthorized && (
          <div className="m-auto max-w-md w-full flex flex-col items-center justify-center py-16 px-6">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="w-full bg-bento-card border border-bento-error/20 rounded-2xl p-8 shadow-2xl text-center flex flex-col items-center gap-6"
            >
              <div className="w-16 h-16 bg-bento-error/10 border border-bento-error/30 text-bento-error rounded-2xl flex items-center justify-center shadow-inner">
                <AlertTriangle className="w-8 h-8 animate-bounce" />
              </div>

              <div>
                <h2 className="text-2xl font-bold text-white tracking-tight">Access Prohibited</h2>
                <p className="text-sm text-bento-dim mt-2">
                  You successfully authenticated, but your email address <span className="text-bento-error font-semibold">{user.email}</span> does not belong to the primary administrator roster.
                </p>
                <p className="text-xs text-bento-dim mt-2">
                  If you are the owner, please log out and select the registered Google account: <strong>gentakanashi0425@gmail.com</strong>.
                </p>
              </div>

              <button 
                onClick={handleLogout}
                className="w-full py-3 px-4 bg-bento-bg hover:bg-bento-card text-bento-bright font-semibold rounded-xl flex items-center justify-center gap-2 active:scale-95 transition-all border border-bento-border"
              >
                <LogOut className="w-4 h-4" />
                Log Out & Retry
              </button>
            </motion.div>
          </div>
        )}

        {/* 3. AUTHORIZED ADMIN PANEL CONTAINER */}
        {user && isAuthorized && (
          <div className="flex flex-col gap-6">

            {/* Navigation Tabs and Top Stats / Actions Panel */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-bento-card p-4 rounded-xl border border-bento-border">
              <div className="flex gap-2 p-1 bg-bento-bg border border-bento-border rounded-xl">
                <button
                  onClick={() => setActiveTab('articles')}
                  className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-all ${activeTab === 'articles' ? 'bg-bento-accent text-bento-bg font-bold shadow-[0_0_12px_rgba(63,185,80,0.15)]' : 'text-bento-dim hover:text-bento-bright'}`}
                >
                  <Rss className="w-4 h-4" />
                  Feed Reader ({recentArticles.length})
                </button>
                <button
                  onClick={() => setActiveTab('sources')}
                  className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-all ${activeTab === 'sources' ? 'bg-bento-accent text-bento-bg font-bold shadow-[0_0_12px_rgba(63,185,80,0.15)]' : 'text-bento-dim hover:text-bento-bright'}`}
                >
                  <Layout className="w-4 h-4" />
                  Monitored Blogs ({sources.length})
                </button>
                <button
                  onClick={() => setActiveTab('scheduler')}
                  className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-all ${activeTab === 'scheduler' ? 'bg-bento-accent text-bento-bg font-bold shadow-[0_0_12px_rgba(63,185,80,0.15)]' : 'text-bento-dim hover:text-bento-bright'}`}
                >
                  <Terminal className="w-4 h-4" />
                  Cloud Scheduler Cron Config
                </button>
                <button
                  onClick={() => setActiveTab('diagnostics')}
                  className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-all ${activeTab === 'diagnostics' ? 'bg-bento-accent text-bento-bg font-bold shadow-[0_0_12px_rgba(63,185,80,0.15)]' : 'text-bento-dim hover:text-bento-bright'}`}
                >
                  <Server className="w-4 h-4" />
                  Database Diagnostics
                </button>
              </div>

              <div className="flex gap-2.5 w-full md:w-auto">
                <button
                  onClick={handleReSeed}
                  disabled={loadingSources}
                  className="flex-1 md:flex-initial flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold bg-bento-bg hover:bg-bento-card text-bento-bright border border-bento-border rounded-xl active:scale-95 transition-all disabled:opacity-50"
                  title="Reset list database with default research domains"
                >
                  <RefreshCw className="w-4 h-4" />
                  Restore Seeds
                </button>
                <button
                  onClick={handleRunCheck}
                  disabled={isChecking}
                  className="flex-1 md:flex-initial flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold bg-bento-accent hover:bg-opacity-90 text-bento-bg rounded-xl active:scale-95 transition-all disabled:opacity-50 shadow-[0_0_12px_rgba(63,185,80,0.2)]"
                >
                  {isChecking ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-bento-bg" />
                      Checking Updates...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 text-bento-bg fill-bento-bg" />
                      Scan & Check Now
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Sweep Investigation Results Box */}
            <AnimatePresence>
              {checkResult && (
                <motion.div 
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="bg-bento-card border border-bento-accent/20 rounded-xl overflow-hidden shadow-xl"
                >
                  <div className="p-4 bg-bento-bg/50 border-b border-bento-border px-6 flex justify-between items-center">
                    <div className="flex items-center gap-2.5 text-bento-accent">
                      <Sparkles className="w-5 h-5 animate-pulse" />
                      <span className="font-bold text-sm tracking-tight text-white">Latest Sweep Investigation Complete</span>
                    </div>
                    <button 
                      onClick={() => setCheckResult(null)} 
                      className="text-bento-dim hover:text-bento-bright p-1 hover:bg-bento-bg rounded-lg transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  
                  <div className="p-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                      <div className="p-4 bg-bento-bg border border-bento-border rounded-xl">
                        <span className="text-xs text-bento-dim block font-medium">New Articles Detected</span>
                        <span className="text-2xl font-bold text-bento-accent block mt-1">{checkResult.newArticlesCount}</span>
                      </div>
                      <div className="p-4 bg-bento-bg border border-bento-border rounded-xl">
                        <span className="text-xs text-bento-dim block font-medium">Diagnostic Health Alerts Sent</span>
                        <span className="text-2xl font-bold text-bento-error block mt-1">{checkResult.healthAlertsDispatched}</span>
                      </div>
                    </div>

                    {checkResult.newArticles.length > 0 ? (
                      <div className="bg-bento-bg rounded-xl border border-bento-border overflow-hidden">
                        <div className="bg-bento-card border-b border-bento-border px-4 py-2.5 text-xs font-semibold text-bento-bright">
                          Discovered Articles (Saved to seen_articles)
                        </div>
                        <div className="max-h-60 overflow-y-auto divide-y divide-bento-border">
                          {checkResult.newArticles.map((art, idx) => (
                            <div key={idx} className="p-3.5 hover:bg-bento-card/40 flex justify-between items-center gap-4 transition-colors">
                              <div>
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-[10px] tracking-wide font-semibold uppercase px-2 py-0.5 rounded-full bg-bento-accent/10 text-bento-accent border border-bento-accent/20">
                                    {art.sourceName}
                                  </span>
                                </div>
                                <h4 className="text-sm font-medium text-bento-bright">{art.title}</h4>
                                <span className="text-xs text-bento-dim font-mono break-all mt-1 block">{art.url}</span>
                              </div>
                              <a 
                                href={art.url} 
                                target="_blank" 
                                rel="noreferrer"
                                className="p-2 hover:bg-bento-card text-bento-dim hover:text-bento-bright rounded-lg transition-colors flex-shrink-0"
                              >
                                <ExternalLink className="w-4 h-4" />
                              </a>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-6 bg-bento-bg rounded-xl border border-dashed border-bento-border">
                        <p className="text-bento-dim text-sm">No new articles detected in this cycle. Mail digest omitted.</p>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* TAB: Feed Reader (Feedly-styled Grouped View) */}
            {activeTab === 'articles' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                {/* Lateral Sidebar (Blog Sources List Groupings) */}
                <div className="lg:col-span-4 flex flex-col gap-4 bg-bento-card p-5 rounded-xl border border-bento-border">
                  <div className="flex justify-between items-center pb-2 border-b border-bento-border">
                    <div>
                      <h3 className="font-bold text-white text-sm tracking-tight flex items-center gap-2">
                        <Rss className="w-4 h-4 text-bento-accent" />
                        Blog & Source Groups
                      </h3>
                      <p className="text-[11px] text-bento-dim mt-0.5">Filter feed articles by company or blog</p>
                    </div>
                    {/* Mark all as read button */}
                    <button
                      onClick={() => {
                        const allUrls = recentArticles.map(a => a.url);
                        setReadArticleUrls(allUrls);
                        try {
                          localStorage.setItem('visited_articles', JSON.stringify(allUrls));
                        } catch (err) {
                          console.error(err);
                        }
                      }}
                      className="text-[10px] bg-bento-bg hover:bg-bento-border px-2 py-1 rounded-md text-bento-dim hover:text-bento-bright border border-bento-border transition-all"
                      title="Mark all listed articles as read"
                    >
                      All Read
                    </button>
                  </div>

                  <div className="flex flex-col gap-1 max-h-[450px] overflow-y-auto pr-1">
                    {/* "All" Group Selector */}
                    <button
                      onClick={() => setSelectedFeedSourceId('all')}
                      className={`flex justify-between items-center px-3.5 py-3 rounded-lg text-left text-xs transition-all border ${
                        selectedFeedSourceId === 'all'
                          ? 'bg-bento-accent/15 text-bento-accent border-bento-accent/30 font-bold'
                          : 'bg-bento-bg hover:bg-bento-bg/70 text-bento-dim border-transparent'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Globe className="w-3.5 h-3.5" />
                        <span>All Monitored Sources</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {recentArticles.filter(art => !readArticleUrls.includes(art.url)).length > 0 && (
                          <span className="px-1.5 py-0.5 text-[9px] rounded-full bg-bento-accent text-bento-bg font-bold animate-pulse">
                            {recentArticles.filter(art => !readArticleUrls.includes(art.url)).length}
                          </span>
                        )}
                        <span className="text-[10px] text-bento-dim font-mono">({recentArticles.length})</span>
                      </div>
                    </button>

                    {/* Individual Blog Sources Selectors */}
                    {sources.map(src => {
                      const sourceArticles = recentArticles.filter(art => art.sourceId === src.id);
                      const unreadCount = sourceArticles.filter(art => !readArticleUrls.includes(art.url)).length;
                      return (
                        <button
                          key={src.id}
                          onClick={() => setSelectedFeedSourceId(src.id)}
                          className={`flex justify-between items-center px-3.5 py-3 rounded-lg text-left text-xs transition-all border ${
                            selectedFeedSourceId === src.id
                              ? 'bg-bento-accent/15 text-bento-accent border-bento-accent/30 font-bold'
                              : 'bg-bento-bg hover:bg-bento-bg/70 text-bento-dim border-transparent'
                          }`}
                        >
                          <div className="flex items-center gap-2 truncate">
                            {src.type === 'rss' ? (
                              <Rss className="w-3.5 h-3.5 text-bento-accent shrink-0" />
                            ) : src.type === 'sitemap' ? (
                              <FileText className="w-3.5 h-3.5 text-bento-bright shrink-0" />
                            ) : (
                              <Code className="w-3.5 h-3.5 text-bento-dim shrink-0" />
                            )}
                            <span className="truncate">{src.name}</span>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0 ml-1 font-mono">
                            {unreadCount > 0 && (
                              <span className="px-1.5 py-0.5 text-[9px] rounded-full bg-bento-accent text-bento-bg font-bold">
                                {unreadCount}
                              </span>
                            )}
                            <span className="text-[10px] text-bento-dim">({sourceArticles.length})</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Main Feeds Timeline Stream (Column lg:8) */}
                <div className="lg:col-span-8 bg-bento-card p-6 rounded-xl border border-bento-border">
                  <div className="flex justify-between items-center pb-4 border-b border-bento-border mb-4">
                    <div>
                      <h3 className="font-bold text-white text-sm tracking-tight">
                        {selectedFeedSourceId === 'all' 
                          ? 'Latest Stream Updates - All Sources' 
                          : `${sources.find(s => s.id === selectedFeedSourceId)?.name || 'Blog'} Publications`}
                      </h3>
                      <p className="text-[11px] text-bento-dim mt-0.5">
                        Showing {selectedFeedSourceId === 'all' 
                          ? recentArticles.length 
                          : recentArticles.filter(art => art.sourceId === selectedFeedSourceId).length} indexed items
                      </p>
                    </div>

                    {/* Quick reset active visited list */}
                    {readArticleUrls.length > 0 && (
                      <button
                        onClick={() => {
                          setReadArticleUrls([]);
                          try {
                            localStorage.removeItem('visited_articles');
                          } catch (err) {
                            console.error(err);
                          }
                        }}
                        className="text-[10px] bg-bento-bg hover:bg-bento-border px-2 py-1 rounded text-bento-dim hover:text-bento-bright border border-bento-border transition-colors animate-fade-in"
                      >
                        Reset Read Status
                      </button>
                    )}
                  </div>

                  {loadingArticles ? (
                    <div className="py-12 flex flex-col items-center justify-center gap-3">
                      <Loader2 className="w-8 h-8 text-bento-accent animate-spin" />
                      <span className="text-xs text-bento-dim font-mono">Retrieving stream updates from firestore cache...</span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 max-h-[600px] overflow-y-auto pr-1">
                      {/* Filter recentArticles */}
                      {(selectedFeedSourceId === 'all' 
                        ? recentArticles 
                        : recentArticles.filter(art => art.sourceId === selectedFeedSourceId)
                      ).length === 0 ? (
                        <div className="text-center py-16 bg-bento-bg/30 rounded-xl border border-dashed border-bento-border">
                          <Rss className="w-10 h-10 text-bento-dim/30 mx-auto mb-2.5" />
                          <h4 className="text-sm font-semibold text-bento-bright">No articles logged for this blog</h4>
                          <p className="text-xs text-bento-dim max-w-xs mx-auto mt-1">
                            Run "Scan & Check Now" at the top right to crawl monitored blogs and trigger automatic updates.
                          </p>
                        </div>
                      ) : (
                        (selectedFeedSourceId === 'all' 
                          ? recentArticles 
                          : recentArticles.filter(art => art.sourceId === selectedFeedSourceId)
                        ).map(art => {
                          const isRead = readArticleUrls.includes(art.url);
                          const sourceName = sources.find(s => s.id === art.sourceId)?.name || 'AI Source';
                          
                          return (
                            <div 
                              key={art.id} 
                              className={`p-4 bg-bento-bg border rounded-xl flex justify-between items-start gap-4 transition-all hover:border-bento-accent/30 ${
                                isRead ? 'opacity-40 border-bento-border/70 saturate-50' : 'border-bento-border shadow-[0_1px_5px_rgba(0,0,0,0.2)]'
                              }`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                                  <span className="text-[9px] font-mono uppercase bg-bento-accent/10 border border-bento-accent/20 text-bento-accent px-1.5 py-0.5 rounded-md">
                                    {sourceName}
                                  </span>
                                  {art.firstSeenAt && (
                                    <span className="text-[10px] text-bento-dim font-mono">
                                      Indexed: {new Date(art.firstSeenAt).toLocaleDateString('ja-JP')}
                                    </span>
                                  )}
                                  {!isRead && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-bento-accent animate-pulse" title="Unread Article" />
                                  )}
                                </div>

                                <h4 className={`text-sm font-bold tracking-tight mb-2 transition-colors duration-200 ${
                                  isRead ? 'text-bento-dim group-hover:text-bento-bright' : 'text-bento-bright'
                                }`}>
                                  <a 
                                    href={art.url} 
                                    target="_blank" 
                                    rel="noreferrer"
                                    onClick={() => handleMarkAsRead(art.url)}
                                    className="hover:underline hover:text-bento-accent focus:outline-none focus:underline"
                                  >
                                    {art.title}
                                  </a>
                                </h4>

                                {/* SUMMARY / OVERVIEW FIELD (Visible at a glance!) */}
                                <p className={`text-xs leading-relaxed ${
                                  isRead ? 'text-bento-dim/70' : 'text-bento-dim'
                                }`}>
                                  {art.description || 'Discovered new publication entry from source stream. Click to read entire content.'}
                                </p>
                              </div>

                              <a 
                                href={art.url} 
                                target="_blank" 
                                rel="noreferrer"
                                onClick={() => handleMarkAsRead(art.url)}
                                className="p-2.5 bg-bento-card border border-bento-border hover:border-bento-accent/40 text-bento-dim hover:text-bento-bright rounded-lg transition-all shrink-0 active:scale-95 shadow-inner"
                                title="Open publication article"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 1: Monitored Channels & Sources */}
            {activeTab === 'sources' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                
                {/* Addition Form Column (lg:4) */}
                <div className="lg:col-span-4 bg-bento-card p-6 rounded-xl border border-bento-border flex flex-col gap-5">
                  <div>
                    <h3 className="font-bold text-white tracking-tight flex items-center gap-2">
                      <Plus className="w-5 h-5 text-bento-accent" />
                      Add Monitor Target
                    </h3>
                    <p className="text-xs text-bento-dim mt-1">Provide a simple URL. Auto-detection handles types.</p>
                  </div>

                  <form onSubmit={handleAddSource} className="flex flex-col gap-4">
                    <div>
                      <label className="text-xs font-semibold text-bento-dim block mb-1.5 font-mono">Blog URL</label>
                      <input 
                        type="url"
                        placeholder="https://openai.com/news/"
                        required
                        value={newSourceUrl}
                        onChange={e => setNewSourceUrl(e.target.value)}
                        onBlur={handleUrlInputBlur}
                        className="w-full bg-bento-bg border border-bento-border focus:border-bento-accent focus:ring-1 focus:ring-bento-accent rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-bento-dim/40 outline-none transition-all"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-semibold text-bento-dim block mb-1.5 font-mono">
                        Display Name {detectingType && <Loader2 className="inline ml-1.5 w-3 h-3 text-bento-accent animate-spin" />}
                      </label>
                      <input 
                        type="text"
                        placeholder="e.g. OpenAI News"
                        required
                        value={newSourceName}
                        onChange={e => setNewSourceName(e.target.value)}
                        className="w-full bg-bento-bg border border-bento-border focus:border-bento-accent focus:ring-1 focus:ring-bento-accent rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-bento-dim/40 outline-none transition-all"
                      />
                    </div>

                    {/* Auto-Discovery Feedback Display */}
                    <AnimatePresence>
                      {detectingType && (
                        <motion.div 
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="p-3 bg-bento-bg rounded-xl border border-bento-border text-xs flex gap-2.5 items-center text-bento-dim"
                        >
                          <Loader2 className="w-3.5 h-3.5 text-bento-accent animate-spin" />
                          <span>Pinging target server for feed formats...</span>
                        </motion.div>
                      )}

                      {!detectingType && addDiscoveryResult && (
                        <motion.div 
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          className="p-3.5 bg-bento-bg rounded-xl border border-bento-border text-xs flex flex-col gap-2"
                        >
                          <div className="flex justify-between items-center">
                            <span className="text-bento-dim">Detected format:</span>
                            <span className={`px-2 py-0.5 rounded font-mono font-bold uppercase text-[10px] ${
                              addDiscoveryResult.type === 'rss' ? 'bg-bento-accent/10 text-bento-accent border border-bento-accent/20' : 
                              addDiscoveryResult.type === 'sitemap' ? 'bg-purple-950/85 text-purple-400 border border-purple-900/50' :
                              'bg-indigo-950/85 text-indigo-400 border border-indigo-900/50'
                            }`}>
                              {addDiscoveryResult.type}
                            </span>
                          </div>
                          
                          {addDiscoveryResult.type === 'scrape' && (
                            <div className="mt-1 flex flex-col gap-1.5 pt-1.5 border-t border-bento-border text-bento-dim">
                              <span>Custom scrapers require a CSS element selector parameter to target post links.</span>
                              <input 
                                type="text"
                                placeholder="Selector (e.g. article a, .post-card a)"
                                required
                                value={newSourceSelector}
                                onChange={e => setNewSourceSelector(e.target.value)}
                                className="w-full bg-bento-bg border border-bento-border focus:border-bento-accent focus:ring-1 focus:ring-bento-accent rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-bento-dim/30 outline-none transition-all"
                              />
                            </div>
                          )}

                          {addDiscoveryResult.type === 'rss' && addDiscoveryResult.feedUrl && (
                            <div className="text-[11px] text-bento-accent break-all font-mono font-medium">
                              Feed: {addDiscoveryResult.feedUrl}
                            </div>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <button 
                      type="submit"
                      disabled={isAdding || detectingType}
                      className="w-full mt-2 py-3 px-4 bg-bento-accent hover:opacity-95 text-bento-bg font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed text-xs shadow-lg shadow-bento-accent/10"
                    >
                      {isAdding ? <Loader2 className="w-4 h-4 animate-spin text-bento-bg" /> : <Plus className="w-4 h-4" />}
                      Register New Monitor Source
                    </button>
                  </form>
                </div>

                {/* List Column (lg:8) */}
                <div className="lg:col-span-8 flex flex-col gap-4">
                  {/* Grid of Sources cards */}
                  {loadingSources ? (
                    <div className="py-20 text-center bg-bento-card border border-bento-border rounded-xl flex flex-col items-center justify-center">
                      <Loader2 className="w-8 h-8 text-bento-accent animate-spin mb-3" />
                      <span className="text-bento-dim text-sm">Synchronizing monitor channels...</span>
                    </div>
                  ) : sources.length === 0 ? (
                    <div className="py-20 text-center bg-bento-card border border-dashed border-bento-border rounded-xl flex flex-col items-center justify-center p-6">
                      <Layout className="w-10 h-10 text-bento-dim mb-3" />
                      <h4 className="font-semibold text-white text-base">No Monitored Blogs Registered</h4>
                      <p className="text-xs text-bento-dim mt-1 max-w-sm">
                        Use the sidebar to add a blog URL or click "Restore Seeds" below to reload authentic AI developer news nodes instantly.
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-4">
                      {sources.map((source) => (
                        <div 
                          key={source.id}
                          className={`bg-bento-card hover:bg-opacity-95 p-5 rounded-xl border transition-all duration-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 ${
                            !source.enabled ? 'border-bento-border opacity-50' : source.lastError ? 'border-bento-error/30' : 'border-bento-border'
                          }`}
                        >
                          {/* Channel Primary Details */}
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 mb-2">
                              <h4 className="font-bold text-white text-base tracking-tight truncate max-w-[240px] sm:max-w-none">{source.name}</h4>
                              
                              {/* Type badges */}
                              <span className={`text-[10px] uppercase font-mono font-semibold px-2 py-0.5 rounded border ${
                                source.type === 'rss' ? 'bg-bento-accent/10 text-bento-accent border-bento-accent/20' : 
                                source.type === 'sitemap' ? 'bg-purple-950/80 text-purple-400 border-purple-900/40 font-semibold' :
                                'bg-bento-warning/10 text-bento-warning border-bento-warning/20 font-semibold'
                              }`}>
                                {source.type}
                              </span>

                              {/* Alert states badge */}
                              {source.lastError ? (
                                <span className="text-[10px] px-2 py-0.5 bg-bento-error/10 text-bento-error border border-bento-error/20 rounded flex items-center gap-1 font-semibold">
                                  <AlertTriangle className="w-3 h-3" /> Error
                                </span>
                              ) : (
                                <span className="text-[10px] px-2 py-0.5 bg-bento-accent/10 text-bento-accent border border-bento-accent/20 rounded flex items-center gap-0.5 font-medium">
                                  <CheckCircle className="w-3 h-3" /> Normal
                                </span>
                              )}

                              {source.type === 'scrape' && source.consecutiveEmptyCount > 0 && (
                                <span className={`text-[10px] px-2 py-0.5 rounded border flex items-center gap-1 font-semibold ${
                                  source.consecutiveEmptyCount >= 3 ? 'bg-bento-error/15 text-bento-error border-bento-error/30 animate-pulse' : 'bg-bento-warning/10 text-bento-warning border-bento-warning/20'
                                }`}>
                                  Empty: {source.consecutiveEmptyCount}/3
                                </span>
                              )}
                            </div>

                            {/* Info Links */}
                            <div className="flex flex-col gap-1.5 text-xs text-bento-dim">
                              <span className="flex items-center gap-1">
                                <Globe className="w-3.5 h-3.5 text-bento-dim/60" />
                                <a href={source.pageUrl} target="_blank" rel="noreferrer" className="hover:text-bento-accent hover:underline inline-flex items-center gap-1 truncate max-w-[280px] sm:max-w-none">
                                  {source.pageUrl}
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                              </span>

                              {source.feedUrl && (
                                <span className="flex items-center gap-1 font-mono text-[11px] text-bento-dim/80 truncate">
                                  <Link className="w-3.5 h-3.5 text-bento-dim/50" />
                                  Feed: {source.feedUrl}
                                </span>
                              )}

                              <div className="flex items-center gap-2 mt-1 py-1 px-2.5 bg-bento-bg border border-bento-border w-fit text-[11px] rounded-lg">
                                <Clock className="w-3 h-3 text-bento-dim" />
                                <span>Checked at: <strong className="text-bento-bright font-medium">{formatLastCheck(source.lastCheckedAt)}</strong></span>
                              </div>

                              {source.lastError && (
                                <div className="mt-2 text-[11px] font-mono text-bento-error/90 bg-bento-error/5 p-2.5 rounded-lg border border-bento-error/20">
                                  <strong>LastError:</strong> {source.lastError}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Control Swaps and Delete Action Block */}
                          <div className="flex items-center gap-4 border-t sm:border-t-0 border-bento-border pt-4 sm:pt-0 justify-between self-stretch sm:self-auto">
                            <div className="flex flex-col gap-1.5">
                              {/* Selector Editing Block for scrape type */}
                              {source.type === 'scrape' && (
                                <div className="flex items-center gap-1.5">
                                  {editingId === source.id ? (
                                    <div className="flex items-center gap-1">
                                      <input 
                                        type="text"
                                        value={editingSelectorText}
                                        onChange={e => setEditingSelectorText(e.target.value)}
                                        className="bg-bento-bg border border-bento-border rounded px-2 py-1 text-xs text-white max-w-[120px]"
                                      />
                                      <button 
                                        onClick={() => handleSaveSelector(source.id)}
                                        className="p-1 px-2 bg-bento-accent hover:opacity-90 text-bento-bg font-bold rounded text-xs"
                                      >
                                        Save
                                      </button>
                                      <button 
                                        onClick={() => setEditingId(null)}
                                        className="p-1 px-2 text-xs bg-bento-bg border border-bento-border rounded hover:bg-bento-card"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  ) : (
                                    <button 
                                      onClick={() => {
                                        setEditingId(source.id);
                                        setEditingSelectorText(source.selector || '');
                                      }}
                                      className="text-xs text-bento-dim hover:text-white flex items-center gap-1 px-2 py-1 bg-bento-bg hover:bg-bento-card rounded border border-bento-border"
                                    >
                                      <Code className="w-3.5 h-3.5" />
                                      Selector: <code className="text-bento-accent font-mono font-semibold">{source.selector || 'empty'}</code>
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Active Action Controls */}
                            <div className="flex items-center gap-3">
                              {/* Toggle active / inactive switch */}
                              <button 
                                onClick={() => handleToggleEnabled(source)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold transition-all ${
                                  source.enabled 
                                    ? 'bg-bento-accent/10 border-bento-accent/30 hover:border-bento-accent text-bento-accent' 
                                    : 'bg-bento-bg border-bento-border text-bento-dim hover:text-white'
                                }`}
                                title={source.enabled ? 'Click to deactivate monitor' : 'Click to enable monitor'}
                              >
                                {source.enabled ? 'Active' : 'Muted'}
                              </button>

                              {/* Delete option */}
                              {deleteConfirmId === source.id ? (
                                <div className="flex items-center gap-1 bg-bento-error/10 border border-bento-error rounded-xl p-1 animate-fade-in shrink-0">
                                  <span className="text-[10px] text-bento-error font-bold px-1 select-none">Delete?</span>
                                  <button 
                                    onClick={() => {
                                      handleDeleteSource(source.id);
                                      setDeleteConfirmId(null);
                                    }} 
                                    className="px-2 py-1 bg-bento-error hover:bg-bento-error/80 text-white text-[10px] font-bold rounded-lg transition-all"
                                    title="Yes, delete"
                                  >
                                    Yes
                                  </button>
                                  <button 
                                    onClick={() => setDeleteConfirmId(null)} 
                                    className="px-2 py-1 bg-bento-bg hover:bg-bento-border text-bento-dim text-[10px] font-bold rounded-lg transition-all"
                                    title="Cancel deletion"
                                  >
                                    No
                                  </button>
                                </div>
                              ) : (
                                <button 
                                  onClick={() => setDeleteConfirmId(source.id)} 
                                  className="p-2 bg-bento-bg hover:bg-bento-error/15 border border-bento-border hover:border-bento-error rounded-xl text-bento-dim hover:text-bento-error transition-all active:scale-90 animate-fade-in shrink-0"
                                  title="Remove monitor target"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </div>
            )}

            {/* TAB 2: cloud scheduler setup guide */}
            {activeTab === 'scheduler' && (
              <div className="max-w-4xl mx-auto w-full bg-bento-card p-6 sm:p-8 rounded-xl border border-bento-border flex flex-col gap-6">
                <div>
                  <h3 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                    <Terminal className="w-6 h-6 text-bento-accent" />
                    Automating Investigation via GCP Cloud Scheduler
                  </h3>
                  <p className="text-bento-dim text-sm mt-1">
                    To trigger daily updates automatically twice a day (e.g. at 9:00 AM and 9:00 PM), configure a GCP Cloud Scheduler task pointing to this applet.
                  </p>
                </div>

                <div className="flex flex-col gap-4">
                  {/* Step List card */}
                  <div className="p-5 bg-bento-bg rounded-xl border border-bento-border">
                    <h4 className="text-sm font-bold text-white mb-3 flex items-center gap-1.5">
                      <Settings className="w-4 h-4 text-bento-accent" /> Step 1: Open Cloud Scheduler in Console
                    </h4>
                    <p className="text-xs text-bento-dim leading-relaxed">
                      Go to the GCP Console for your project: <code className="text-bento-accent font-mono bg-bento-card px-1 py-0.5 rounded">gen-lang-client-0785261571</code>. 
                      Open <strong>Cloud Scheduler</strong> and click <strong>"Create Job"</strong>.
                    </p>
                  </div>

                  <div className="p-5 bg-bento-bg rounded-xl border border-bento-border flex flex-col gap-3">
                    <h4 className="text-sm font-bold text-white flex items-center gap-1.5">
                      <Layout className="w-4 h-4 text-bento-accent" /> Step 2: Define Scheduler Properties
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono">
                      <div className="p-3 bg-bento-card border border-bento-border rounded-xl">
                        <span className="text-bento-dim block text-[10px]">Name</span>
                        <span className="text-white block mt-1 font-semibold">ai-notifier-cron-checker</span>
                      </div>
                      <div className="p-3 bg-bento-card border border-bento-border rounded-xl">
                        <span className="text-bento-dim block text-[10px]">Frequency (Cron)</span>
                        <span className="text-bento-accent block mt-1 font-bold">0 9,21 * * *</span>
                        <span className="text-[10px] text-bento-dim font-sans block mt-1">Runs twice a day at 09:00 & 21:00 UTC</span>
                      </div>
                      <div className="p-3 bg-bento-card border border-bento-border rounded-xl col-span-1 sm:col-span-2">
                        <span className="text-bento-dim block text-[10px]">Time zone</span>
                        <span className="text-white block mt-1">Select your local timezone (e.g. Asia/Tokyo)</span>
                      </div>
                    </div>
                  </div>

                  <div className="p-5 bg-bento-bg rounded-xl border border-bento-border flex flex-col gap-3">
                    <h4 className="text-sm font-bold text-white flex items-center gap-1.5">
                      <Mail className="w-4 h-4 text-bento-warning" /> Step 3: Configure Target Delivery (HTTP POST)
                    </h4>
                    <div className="flex flex-col gap-2.5 text-xs">
                      <div className="p-3 bg-bento-card border border-bento-border rounded-xl font-mono">
                        <span className="text-bento-dim block text-[10px]">Target Type</span>
                        <span className="text-white block mt-1">HTTP</span>
                      </div>
                      <div className="p-3 bg-bento-card border border-bento-border rounded-xl font-mono">
                        <span className="text-bento-dim block text-[10px]">URL</span>
                        <span className="text-bento-warning block break-all mt-1">
                          {window.location.origin}/api/check?secret=some-secure-random-phrase-goes-here
                        </span>
                        <span className="text-[10px] text-bento-dim font-sans block mt-1.5 leading-relaxed">
                          ⚠️ Replace with your live service URL endpoint. Include the <code className="text-bento-warning font-mono bg-bento-bg px-1 py-0.5 rounded">?secret=TOKEN</code> matching your private env configuration.
                        </span>
                      </div>
                      <div className="p-3 bg-bento-card border border-bento-border rounded-xl font-mono">
                        <span className="text-bento-dim block text-[10px]">HTTP Method</span>
                        <span className="text-white block mt-1 font-semibold">POST</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: System Diagnostics */}
            {activeTab === 'diagnostics' && (
              <div className="max-w-4xl mx-auto w-full bg-bento-card p-6 sm:p-8 rounded-xl border border-bento-border flex flex-col gap-6">
                <div>
                  <h3 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                    <Server className="w-6 h-6 text-bento-accent" />
                    Database & Environment Diagnostics
                  </h3>
                  <p className="text-bento-dim text-sm mt-1">
                    Fetch live server-side check status to verify if <code className="text-bento-accent font-mono bg-bento-bg px-1 py-0.5 rounded">FIREBASE_SERVICE_ACCOUNT</code> environment credentials are loaded, syntactically correct, and fully authorized to access Google Cloud Firestore.
                  </p>
                </div>

                <div className="flex flex-col gap-5">
                  <div className="flex justify-start">
                    <button
                      onClick={handleDiagnose}
                      disabled={diagnosing}
                      className="flex items-center gap-2 px-5 py-3 text-xs font-bold bg-bento-accent hover:bg-opacity-90 text-bento-bg rounded-xl disabled:opacity-50 transition-all shadow-[0_0_12px_rgba(63,185,80,0.25)]"
                    >
                      {diagnosing ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin text-bento-bg" />
                          Testing connections...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="w-4 h-4 text-bento-bg" />
                          Run Server-Side Diagnostics
                        </>
                      )}
                    </button>
                  </div>

                  {diagnoseResult ? (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex flex-col gap-5"
                    >
                      {/* Connection Health Overview */}
                      <div className={`p-5 rounded-xl border flex gap-3.5 items-start ${
                        diagnoseResult.firestoreConnection.authorized 
                          ? 'bg-bento-accent/5 border-bento-accent/30 text-bento-accent' 
                          : 'bg-bento-error/5 border-bento-error/30 text-bento-error'
                      }`}>
                        {diagnoseResult.firestoreConnection.authorized ? (
                          <CheckCircle className="w-6 h-6 flex-shrink-0 text-bento-accent" />
                        ) : (
                          <AlertTriangle className="w-6 h-6 flex-shrink-0 text-bento-error" />
                        )}
                        <div>
                          <h4 className="font-bold text-sm text-white">
                            Firestore Status: {diagnoseResult.firestoreConnection.authorized ? 'HEALTHY / AUTHORIZED' : 'UNAUTHORIZED / ERROR'}
                          </h4>
                          <p className="text-xs text-bento-dim mt-1.5 leading-relaxed">
                            {diagnoseResult.firestoreConnection.details}
                          </p>
                          {diagnoseResult.firestoreConnection.error && (
                            <code className="block p-3 bg-bento-bg text-[11px] font-mono rounded-lg border border-bento-error/20 mt-3 break-all text-bento-error whitespace-pre-wrap leading-relaxed">
                              {diagnoseResult.firestoreConnection.error}
                            </code>
                          )}
                        </div>
                      </div>

                      {/* Detailed Parameters Grid */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Service Account Profile */}
                        <div className="p-5 bg-bento-bg border border-bento-border rounded-xl flex flex-col gap-3">
                          <span className="text-xs font-bold text-white tracking-wide uppercase border-b border-bento-border pb-1.5 font-mono">
                            FIREBASE_SERVICE_ACCOUNT Secret
                          </span>
                          
                          <div className="flex flex-col gap-2.5 text-xs text-bento-dim">
                            <div className="flex justify-between items-center bg-bento-card/40 p-2 rounded border border-bento-border/50">
                              <span>Secret Present:</span>
                              <span className={`font-semibold text-xs px-2 py-0.5 rounded ${diagnoseResult.serviceAccount.present ? 'bg-bento-accent/10 text-bento-accent' : 'bg-bento-error/10 text-bento-error'}`}>
                                {diagnoseResult.serviceAccount.present ? 'YES' : 'NO'}
                              </span>
                            </div>
                            <div className="flex justify-between items-center bg-bento-card/40 p-2 rounded border border-bento-border/50 font-mono">
                              <span>Valid JSON Format:</span>
                              <span className={`font-semibold text-xs px-2 py-0.5 rounded ${diagnoseResult.serviceAccount.validJson ? 'bg-bento-accent/10 text-bento-accent' : 'bg-bento-error/10 text-bento-error'}`}>
                                {diagnoseResult.serviceAccount.validJson ? 'YES' : 'NO'}
                              </span>
                            </div>
                            <div className="flex flex-col gap-1 bg-bento-card/40 p-2 rounded border border-bento-border/50">
                              <span>Client Email:</span>
                              <span className="font-mono text-white text-[11px] break-all select-all">
                                {diagnoseResult.serviceAccount.clientEmail || 'N/A'}
                              </span>
                            </div>
                            <div className="flex justify-between items-center bg-bento-card/40 p-2 rounded border border-bento-border/50">
                              <span>Private Key Found:</span>
                              <span className={`font-semibold text-xs px-2 py-0.5 rounded ${diagnoseResult.serviceAccount.privateKeyPresent ? 'bg-bento-accent/10 text-bento-accent' : 'bg-bento-error/10 text-bento-error'}`}>
                                {diagnoseResult.serviceAccount.privateKeyPresent ? 'YES' : 'NO'}
                              </span>
                            </div>
                            {diagnoseResult.serviceAccount.error && (
                              <div className="mt-2 text-[10px] font-mono text-bento-error bg-bento-error/5 p-2 rounded border border-bento-error/20">
                                <strong>Parse Error:</strong> {diagnoseResult.serviceAccount.error}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Applet Config context */}
                        <div className="p-5 bg-bento-bg border border-bento-border rounded-xl flex flex-col gap-3">
                          <span className="text-xs font-bold text-white tracking-wide uppercase border-b border-bento-border pb-1.5 font-mono">
                            Database Identifiers (Config)
                          </span>
                          
                          <div className="flex flex-col gap-2.5 text-xs text-bento-dim">
                            <div className="flex flex-col gap-1 bg-bento-card/40 p-2 rounded border border-bento-border/50">
                              <span>Target Project ID:</span>
                              <span className="font-mono text-white select-all">
                                {diagnoseResult.databaseConfig.projectId || 'N/A'}
                              </span>
                            </div>
                            <div className="flex justify-between items-center bg-bento-card/40 p-2 rounded border border-bento-border/50">
                              <span>Target Database ID:</span>
                              <span className="font-mono text-white select-all font-semibold">
                                {diagnoseResult.databaseConfig.databaseId || '(default)'}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                    </motion.div>
                  ) : (
                    <div className="text-center py-10 bg-bento-bg rounded-xl border border-dashed border-bento-border">
                      <p className="text-bento-dim text-sm">No analysis has been fetched for this session yet. Run the check to analyze environmental health parameters.</p>
                    </div>
                  )}

                </div>
              </div>
            )}

          </div>
        )}

      </main>

      {/* Footer copyright */}
      <footer className="border-t border-bento-border py-6 text-center text-xs text-bento-dim bg-bento-bg">
        <p>© 2026 AI Blog Update Notifier. All systems nominal.</p>
      </footer>
    </div>
  );
}
