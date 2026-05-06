/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import JSZip from 'jszip';
import { 
  Book, 
  Library, 
  BarChart2, 
  ChevronLeft, 
  ChevronRight, 
  Bookmark, 
  Menu, 
  UserCircle,
  Plus, 
  FileText, 
  Download, 
  X,
  Edit2,
  Trash2,
  LogIn,
  LogOut,
  Settings,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  ArrowLeft,
  ArrowRight,
  SkipBack,
  Play,
  SkipForward,
  AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db, loginWithGoogle } from './lib/firebase';
import { onAuthStateChanged, User, signOut } from 'firebase/auth';
import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  updateDoc, 
  deleteDoc, 
  query, 
  onSnapshot, 
  serverTimestamp,
  addDoc,
  collectionGroup
} from 'firebase/firestore';
import localforage from 'localforage';

// Initialize localforage
localforage.config({
  name: 'epubstats',
  storeName: 'books_binary'
});

import { 
  format, 
  startOfMonth, 
  endOfMonth, 
  eachDayOfInterval, 
  subMonths, 
  isSameMonth, 
  isToday,
  getDay
} from 'date-fns';

// --- TYPES ---

interface Session {
  date: string;
  duration: number;
}

interface BookStats {
  totalTime: number;
  pagesRead: number;
  sessions: Session[];
}

interface SavedBook {
  name: string;
  title: string;
  chapters: string[];
  currentCh: number;
  zipData: ArrayBuffer;
  coverUrl?: string; // Base64 of cover image
  isLocal?: boolean; // Flag for local-only books
}

interface Annotation {
  text: string;
  date: string;
}

type Screen = 'home' | 'library' | 'reader' | 'stats' | 'upload' | 'calendar';

// --- HELPERS ---

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const message = error instanceof Error ? error.message : String(error);
  
  // Custom check for AI Studio quota limits
  if (message.includes('Quota exceeded') || message.includes('quota metric')) {
    window.dispatchEvent(new CustomEvent('firestore-quota-exceeded'));
  }

  const errInfo: FirestoreErrorInfo = {
    error: message,
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  // In a real app we might toast this, but here we just log it as per instructions
}

const formatTime = (ms: number) => {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${Math.floor(min % 60)}m`;
};

const ab2b64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
};

const b642ab = (b64: string): ArrayBuffer => {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    buf[i] = bin.charCodeAt(i);
  }
  return buf.buffer;
};

// --- COMPONENT ---

export default function App() {
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>('home');
  const [activeTab, setActiveTab] = useState<Screen>('home');
  const [books, setBooks] = useState<SavedBook[]>([]);
  const [localBooks, setLocalBooks] = useState<SavedBook[]>([]);
  const [activeBook, setActiveBook] = useState<SavedBook | null>(null);
  const [currentCh, setCurrentCh] = useState(0);
  const [stats, setStats] = useState<Record<string, BookStats>>({});
  const [isFlipping, setIsFlipping] = useState<'left' | 'right' | null>(null);
  const [showTOC, setShowTOC] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [annotationText, setAnnotationText] = useState('');
  const [chapterContent, setChapterContent] = useState<string>('');
  const [calendarViewDate, setCalendarViewDate] = useState(new Date());
  
  const [fontSize, setFontSize] = useState(18);
  const [alignment, setAlignment] = useState<'left' | 'center' | 'right' | 'justify'>('justify');
  const [showSettings, setShowSettings] = useState(false);
  
  const zipRef = useRef<JSZip | null>(null);
  const sessionStartRef = useRef<number | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  // --- AUTH ---

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setAuthLoading(false);
      if (u) {
        // Sync user profile
        const userRef = doc(db, 'users', u.uid);
        try {
          const userSnap = await getDoc(userRef);
          if (!userSnap.exists()) {
            await setDoc(userRef, {
              userId: u.uid,
              email: u.email || '',
              displayName: u.displayName || '',
              createdAt: serverTimestamp()
            });
          }
        } catch (e) {
          handleFirestoreError(e, OperationType.WRITE, `users/${u.uid}`);
        }
      } else {
        setScreen('upload');
        setBooks([]);
        setActiveBook(null);
      }
    });
  }, []);

  // --- PERSISTENCE ---

  useEffect(() => {
    if (!user) return;

    const booksRef = collection(db, 'users', user.uid, 'books');
    let isSubscribed = true;

    const unsub = onSnapshot(booksRef, async (snapshot) => {
      try {
        const processed: SavedBook[] = [];
        for (const d of snapshot.docs) {
          const data = d.data();
          const bookId = data.title.replace(/[^a-zA-Z0-9]/g, '_');
          
          let zipData = await localforage.getItem<ArrayBuffer>(`bin_${bookId}`);
          
          if (!zipData && data.zipB64) {
            zipData = b642ab(data.zipB64);
            await localforage.setItem(`bin_${bookId}`, zipData);
          }

          // Include book even if zipData is missing (e.g. large book on another device)
          // We handle missing binary in the UI/openBook
          processed.push({
            name: data.name,
            title: data.title,
            chapters: data.chapters,
            currentCh: data.currentCh,
            zipData: zipData || new ArrayBuffer(0), // Fallback to empty if missing
            coverUrl: data.coverUrl
          });
        }
        
        if (isSubscribed) {
          setBooks(processed);
        }
      } catch (err) {
        console.error("Error processing books snapshot:", err);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}/books`);
    });

    return () => {
      isSubscribed = false;
      unsub();
    };
  }, [user, screen]);

  // We also need to fetch sessions and aggregated stats per book
  useEffect(() => {
    if (!user || books.length === 0) return;
    
    // Listen to sessions from all books to build aggregate home stats
    const unsubs = books.map(book => {
      const bookId = book.title.replace(/[^a-zA-Z0-9]/g, '_');
      const sessRef = collection(db, 'users', user.uid, 'books', bookId, 'sessions');
      return onSnapshot(sessRef, (snap) => {
        const sesss: Session[] = [];
        snap.forEach(doc => {
          const data = doc.data();
          sesss.push({
            date: data.date?.toDate?.()?.toISOString() || new Date().toISOString(),
            duration: data.duration
          });
        });
        setStats(prev => {
          // Only update if data actually changed to prevent infinite loops
          const currentSess = prev[book.title]?.sessions || [];
          if (JSON.stringify(currentSess) === JSON.stringify(sesss)) return prev;
          
          return {
            ...prev,
            [book.title]: {
              ...(prev[book.title] || { totalTime: 0, pagesRead: 0, sessions: [] }),
              sessions: sesss
            }
          };
        });
      }, (error) => {
        handleFirestoreError(error, OperationType.GET, `users/${user.uid}/books/${bookId}/sessions`);
      });
    });

    return () => unsubs.forEach(u => u());
  }, [user, books.length]);

  const allSessions = useMemo(() => {
    return (Object.values(stats) as BookStats[]).flatMap(s => s.sessions);
  }, [stats]);

  const activityData = useMemo(() => {
    const map: Record<string, { duration: number; titles: Set<string> }> = {};
    (Object.entries(stats) as [string, BookStats][]).forEach(([title, bookStats]) => {
      bookStats.sessions.forEach(s => {
        const dateKey = s.date.split('T')[0];
        if (!map[dateKey]) map[dateKey] = { duration: 0, titles: new Set() };
        map[dateKey].duration += s.duration;
        map[dateKey].titles.add(title);
      });
    });
    return map;
  }, [stats]);

  const activityByDate = useMemo(() => {
    const map: Record<string, number> = {};
    (Object.entries(activityData) as [string, { duration: number; titles: Set<string> }][]).forEach(([date, data]) => {
      map[date] = data.duration;
    });
    return map;
  }, [activityData]);

  useEffect(() => {
    // Load local books on mount
    const loadLocal = async () => {
      const stored = await localforage.getItem<SavedBook[]>('local_books_metadata');
      if (stored) {
        // Hydrate zipData from their individual keys
        const hydrated = await Promise.all(stored.map(async b => {
          const bookId = b.title.replace(/[^a-zA-Z0-9]/g, '_');
          const data = await localforage.getItem<ArrayBuffer>(`bin_local_${bookId}`);
          return { ...b, zipData: data || new ArrayBuffer(0), isLocal: true };
        }));
        setLocalBooks(hydrated);
      }
    };
    loadLocal();
  }, []);

  const displayedBooks = useMemo(() => {
    // Deduplicate if a book exists in both (unlikely but safe)
    const combined = [...books];
    localBooks.forEach(lb => {
      if (!combined.find(b => b.title === lb.title)) {
        combined.push(lb);
      }
    });
    return combined;
  }, [books, localBooks]);

  const lastReadBook = useMemo(() => {
    if (displayedBooks.length === 0) return null;
    
    // Sort by last session date
    const sorted = [...displayedBooks].sort((a, b) => {
      const statsA = stats[a.title] as BookStats | undefined;
      const statsB = stats[b.title] as BookStats | undefined;
      
      const lastSessionA = statsA && statsA.sessions.length > 0 
        ? Math.max(...statsA.sessions.map(s => new Date(s.date).getTime())) 
        : 0;
      const lastSessionB = statsB && statsB.sessions.length > 0 
        ? Math.max(...statsB.sessions.map(s => new Date(s.date).getTime())) 
        : 0;
        
      if (lastSessionA === 0 && lastSessionB === 0) return 0;
      return lastSessionB - lastSessionA;
    });
    
    return sorted[0];
  }, [displayedBooks, stats]);

  const renderActivityCalendar = () => {
    const start = startOfMonth(calendarViewDate);
    const end = endOfMonth(calendarViewDate);
    const days = eachDayOfInterval({ start, end });
    const startDay = getDay(start); // 0 (Sun) to 6 (Sat)

    const prevMonth = () => setCalendarViewDate(prev => subMonths(prev, 1));
    const nextMonth = () => setCalendarViewDate(prev => {
      const next = new Date(prev);
      next.setMonth(next.getMonth() + 1);
      return next;
    });

    return (
      <div className="bg-brand-card p-8 rounded-[32px] border border-brand-border shadow-soft mb-8 overflow-hidden">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-2 h-5 bg-brand-primary rounded-full"></div>
            <h3 className="font-bold text-brand-text-heading text-sm uppercase tracking-widest">Reading Lifecycle</h3>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setScreen('calendar')}
              className="text-[10px] font-bold text-brand-primary uppercase tracking-widest hover:underline flex items-center gap-2"
            >
              Full Calendar <ArrowRight size={12} />
            </button>
            <div className="flex items-center gap-3 bg-brand-bg/50 p-1 rounded-full border border-brand-border">
              <button 
                onClick={prevMonth}
                className="p-2 hover:bg-white rounded-full text-brand-text-heading/40 hover:text-brand-primary transition-all shadow-sm active:scale-95"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-[11px] font-bold text-brand-text-heading uppercase tracking-widest min-w-[120px] text-center">
                {format(calendarViewDate, 'MMMM yyyy')}
              </span>
              <button 
                onClick={nextMonth}
                className="p-2 hover:bg-white rounded-full text-brand-text-heading/40 hover:text-brand-primary transition-all shadow-sm active:scale-95"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </div>
        
        <div className="max-w-md mx-auto">
          <div className="grid grid-cols-7 gap-2 mb-3">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <div key={i} className="text-center text-[10px] font-bold text-brand-text-heading/20">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-2">
            {/* Empty offsets */}
            {Array.from({ length: startDay }).map((_, i) => (
              <div key={`empty-${i}`} className="aspect-square"></div>
            ))}
            
            {days.map((day) => {
              const key = format(day, 'yyyy-MM-dd');
              const duration = activityByDate[key] || 0;
              const intensity = duration === 0 ? 'bg-white/40' : 
                               duration < 900000 ? 'bg-[#F3CADD]' : 
                               duration < 2700000 ? 'bg-[#DDB6D7]' : 
                               duration < 5400000 ? 'bg-[#B696D7]' : 
                               duration < 10800000 ? 'bg-[#8E7AB5]' : 
                               'bg-[#544A7D].shadow-[0_0_12px_rgba(84,74,125,0.4)]'; 
              
              const [colorClass, shadowClass] = intensity.split('.');

              return (
                <div 
                  key={key} 
                  className={`aspect-square rounded-[8px] ${colorClass} ${shadowClass || ''} transition-all relative group cursor-pointer ${isToday(day) ? 'ring-2 ring-brand-primary ring-offset-2' : ''}`}
                >
                  {/* Custom Tooltip */}
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 hidden group-hover:block z-50">
                    <div className="bg-brand-text-heading text-white text-[10px] font-bold py-1.5 px-3 rounded-full whitespace-nowrap shadow-xl">
                      {format(day, 'MMM d')}: {formatTime(duration)}
                    </div>
                    <div className="w-2 h-2 bg-brand-text-heading rotate-45 mx-auto -mt-1"></div>
                  </div>
                  {duration > 10800000 && <div className="absolute inset-0 flex items-center justify-center"><div className="w-1 h-1 bg-white rounded-full animate-pulse"></div></div>}
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-10 pt-6 border-t border-brand-bg flex items-center justify-between text-[10px] text-brand-text-heading font-bold uppercase tracking-widest">
          <div className="flex gap-3 overflow-x-auto pb-1 no-scrollbar items-center">
             <span className="opacity-40 text-[9px]">IDLE</span>
             <div className="flex gap-1">
               <div className="w-3 h-3 bg-white/40 rounded-sm border border-brand-border" title="0m"></div>
               <div className="w-3 h-3 bg-[#F3CADD] rounded-sm" title="< 15m"></div>
               <div className="w-3 h-3 bg-[#DDB6D7] rounded-sm" title="15m-45m"></div>
               <div className="w-3 h-3 bg-[#B696D7] rounded-sm" title="45m-90m"></div>
               <div className="w-3 h-3 bg-[#8E7AB5] rounded-sm" title="90m-180m"></div>
               <div className="w-3 h-3 bg-[#544A7D] rounded-sm shadow-[0_0_5px_rgba(84,74,125,0.3)]" title="> 180m"></div>
             </div>
             <span className="opacity-40 text-[9px]">PEAK</span>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            <span>Month Sync: <span className="text-brand-primary">{formatTime(days.reduce((acc, day) => acc + (activityByDate[format(day, 'yyyy-MM-dd')] || 0), 0))}</span></span>
          </div>
        </div>
      </div>
    );
  };

  const saveBookToCloud = async (book: SavedBook) => {
    if (!user) return;
    const bookId = book.title.replace(/[^a-zA-Z0-9]/g, '_');
    const bookRef = doc(db, 'users', user.uid, 'books', bookId);
    
    // Store binary locally for size-safe retrieval
    await localforage.setItem(`bin_${bookId}`, book.zipData);

    try {
      const b64 = ab2b64(book.zipData);
      const isTooBig = b64.length > 700000; // conservative limit for ~1MB total document size

      const payload: any = {
      name: book.name,
      title: book.title,
      chapters: book.chapters,
      currentCh: book.currentCh,
      coverUrl: book.coverUrl || '',
      ownerId: user.uid,
      updatedAt: serverTimestamp()
    };

      if (!isTooBig) {
        payload.zipB64 = b64;
      } else {
        console.warn(`Book "${book.title}" is too large for cloud binary sync. Persisting metadata only.`);
      }

      await setDoc(bookRef, payload, { merge: true });
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `users/${user.uid}/books/${bookId}`);
    }
  };

  const saveBookLocally = async (book: SavedBook) => {
    const bookId = book.title.replace(/[^a-zA-Z0-9]/g, '_');
    
    // Store binary
    await localforage.setItem(`bin_local_${bookId}`, book.zipData);
    
    // Update local metadata list
    const current = await localforage.getItem<SavedBook[]>('local_books_metadata') || [];
    const filtered = current.filter(b => b.title !== book.title);
    
    // Strip zipData from metadata list to keep it small
    const metadataOnly = { ...book, zipData: new ArrayBuffer(0), isLocal: true };
    const updatedMetadata = [metadataOnly, ...filtered];
    
    await localforage.setItem('local_books_metadata', updatedMetadata);
    setLocalBooks(prev => {
      const filteredPrev = prev.filter(b => b.title !== book.title);
      return [book, ...filteredPrev];
    });
  };

  // --- EPUB LOADING ---

  const findInZip = (zip: JSZip, target: string) => {
    const t = target.replace(/^\//, '').toLowerCase();
    const files = Object.keys(zip.files);
    for (const key of files) {
      if (key.toLowerCase() === t) return key;
    }
    try {
      const d = decodeURIComponent(t);
      for (const key of files) {
        if (key.toLowerCase() === d) return key;
      }
    } catch (e) {}
    return target;
  };

  const resolvePath = (base: string, rel: string) => {
    if (rel.startsWith('/')) return rel.substring(1);
    const parts = (base + rel).split('/');
    const res: string[] = [];
    for (const p of parts) {
      if (p === '..') res.pop();
      else if (p !== '.' && p !== '') res.push(p);
    }
    return res.join('/');
  };

  const loadEpub = async (file: File, isLocalOnly: boolean = false) => {
    setIsImporting(true);
    setImportError(null);
    try {
      const data = await file.arrayBuffer();
      const zip = await new JSZip().loadAsync(data);
      
      const cPath = findInZip(zip, 'META-INF/container.xml');
      if (!cPath) throw new Error("Invalid EPUB: Missing container.xml");

      const cXmlFile = zip.file(cPath);
      if (!cXmlFile) throw new Error("Invalid EPUB: Cannot read container.xml");

      const cXml = await cXmlFile.async('text');
      const cDoc = new DOMParser().parseFromString(cXml, 'application/xml');
      const rf = cDoc.querySelector('rootfile');
      if (!rf) throw new Error("Invalid EPUB: Missing rootfile in container.xml");

      const opfPath = rf.getAttribute('full-path');
      if (!opfPath) throw new Error("Invalid EPUB: Missing full-path in rootfile");

      const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
      
      const realOpfPath = findInZip(zip, opfPath);
      if (!realOpfPath) throw new Error("Invalid EPUB: Cannot find OPF file");

      const opfFile = zip.file(realOpfPath);
      if (!opfFile) throw new Error("Invalid EPUB: Cannot read OPF file");

      const opfXml = await opfFile.async('text');
      const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

      const titleEl = opfDoc.querySelector('metadata title, dc\\:title');
      const title = titleEl ? titleEl.textContent!.trim() : file.name.replace('.epub', '');

      const manifest: Record<string, string> = {};
      opfDoc.querySelectorAll('manifest item').forEach(it => {
        const id = it.getAttribute('id');
        const href = it.getAttribute('href');
        if (id && href) manifest[id] = opfDir + href;
      });

      const chs: string[] = [];
      opfDoc.querySelectorAll('spine itemref').forEach(ref => {
        const id = ref.getAttribute('idref');
        if (id && manifest[id]) chs.push(manifest[id]);
      });

      if (chs.length === 0) throw new Error("Invalid EPUB: No chapters found in spine");

      let coverUrl = '';
      let coverId = '';
      
      const metaCover = opfDoc.querySelector('metadata meta[name="cover"]');
      if (metaCover) {
        coverId = metaCover.getAttribute('content') || '';
      }
      
      const coverItem = (coverId ? opfDoc.querySelector(`item[id="${coverId}"]`) : null) || 
                        opfDoc.querySelector('item[properties~="cover-image"]') || 
                        opfDoc.querySelector('item[id*="cover"]');
      
      if (coverItem) {
        const cHref = coverItem.getAttribute('href');
        if (cHref) {
          const cPath = opfDir + cHref;
          const realCPath = findInZip(zip, cPath);
          if (realCPath) {
            const cFile = zip.file(realCPath);
            if (cFile) {
              const b64 = await cFile.async('base64');
              const ext = cPath.split('.').pop()?.toLowerCase();
              const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
              coverUrl = `data:${mime};base64,${b64}`;
            }
          }
        }
      }

      const newBook: SavedBook = {
        name: file.name,
        title,
        chapters: chs,
        currentCh: 0,
        zipData: data,
        coverUrl,
        isLocal: isLocalOnly
      };

      if (isLocalOnly) {
        await saveBookLocally(newBook);
      } else if (user) {
        const existingIndex = books.findIndex(b => b.title === title);
        let updatedBooks;
        if (existingIndex !== -1) {
          updatedBooks = [...books];
          updatedBooks[existingIndex] = newBook;
        } else {
          updatedBooks = [...books, newBook];
        }
        setBooks(updatedBooks);
        await saveBookToCloud(newBook);
      } else {
        // Fallback to local if not logged in
        await saveBookLocally(newBook);
      }
      
      openBook(newBook);
    } catch (err) {
      console.error(err);
      setImportError(err instanceof Error ? err.message : "Failed to parse EPUB file. Ensure it is a valid, unencrypted EPUB.");
    } finally {
      setIsImporting(false);
    }
  };

  const openBook = async (book: SavedBook) => {
    if (!book.zipData || book.zipData.byteLength === 0) {
      setImportError(`The fragment "${book.title}" is missing its local binary data. Please re-upload it on this device.`);
      setScreen('upload');
      return;
    }
    setActiveBook(book);
    setCurrentCh(book.currentCh || 0);
    zipRef.current = await JSZip.loadAsync(book.zipData);
    setScreen('reader');
    startSession();
  };

  const renderChapter = async () => {
    if (pageRef.current) pageRef.current.scrollTop = 0;
    if (!activeBook || !zipRef.current) return;
    const path = activeBook.chapters[currentCh];
    const file = zipRef.current.file(findInZip(zipRef.current, path));
    if (!file) {
      setChapterContent('<p class="text-center mt-20 text-gray-500">Chapter not found</p>');
      return;
    }

    let html = await file.async('text');
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) html = bodyMatch[1];
    
    const chDir = path.includes('/') ? path.substring(0, path.lastIndexOf('/') + 1) : '';
    
    // Create a temporary element to process the HTML
    const temp = document.createElement('div');
    temp.innerHTML = html;

    const images = temp.querySelectorAll('img');
    for (const img of Array.from(images)) {
      const src = img.getAttribute('src');
      if (src && !src.startsWith('data:') && !src.startsWith('http')) {
        const resolved = resolvePath(chDir, src);
        const f = zipRef.current.file(findInZip(zipRef.current, resolved));
        if (f) {
          const b = await f.async('base64');
          const ext = resolved.split('.').pop()?.toLowerCase();
          const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : 'image/jpeg';
          img.src = `data:${mime};base64,${b}`;
        }
      }
    }

    setChapterContent(temp.innerHTML);
    if (pageRef.current) pageRef.current.scrollTop = 0;
  };

  useEffect(() => {
    if (screen === 'reader') {
      renderChapter();
    }
  }, [currentCh, activeBook, screen]);

  const getBookStats = (title: string): BookStats => {
    return stats[title] || { totalTime: 0, pagesRead: 0, sessions: [] };
  };

  const exportStats = (format: 'json' | 'csv' | 'txt') => {
    if (!activeBook) return;
    const s = getBookStats(activeBook.title);
    let blob: Blob;
    let filename = `stats_${activeBook.title.replace(/\s+/g, '_')}`;

    if (format === 'json') {
      blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
      filename += '.json';
    } else if (format === 'csv') {
      const header = 'date,duration\n';
      const rows = s.sessions.map(sess => `${sess.date},${sess.duration}`).join('\n');
      blob = new Blob([header + rows], { type: 'text/csv' });
      filename += '.csv';
    } else {
      const content = `Report for ${activeBook.title}\nTotal Time: ${formatTime(s.totalTime)}\nTotal Pages: ${s.pagesRead}\nSessions: ${s.sessions.length}`;
      blob = new Blob([content], { type: 'text/plain' });
      filename += '.txt';
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- ACTIONS ---

  const flipPage = async (dir: number) => {
    if (!activeBook || isFlipping) return;
    const next = currentCh + dir;
    if (next < 0 || next >= activeBook.chapters.length) return;
    
    setIsFlipping(dir > 0 ? 'right' : 'left');
    
    // Optimistic update
    setCurrentCh(next);
    setActiveBook(prev => prev ? { ...prev, currentCh: next } : null);

    if (activeBook.isLocal) {
      // Update local storage metadata with new progress
      const current = await localforage.getItem<SavedBook[]>('local_books_metadata') || [];
      const updated = current.map(b => b.title === activeBook.title ? { ...b, currentCh: next } : b);
      await localforage.setItem('local_books_metadata', updated);
      if (dir > 0) trackPageRead();
    } else if (user) {
      const bookId = activeBook.title.replace(/[^a-zA-Z0-9]/g, '_');
      const bookRef = doc(db, 'users', user.uid, 'books', bookId);
      
      try {
        await updateDoc(bookRef, { 
          currentCh: next,
          updatedAt: serverTimestamp()
        });
        if (dir > 0) trackPageRead();
      } catch (e) {
        console.error("Failed to sync page state", e);
      }
    }

    // Always reset flipping
    setTimeout(() => {
      setIsFlipping(null);
    }, 400); 
  };

  const nextChapter = () => flipPage(1);
  const prevChapter = () => flipPage(-1);

  const startSession = () => {
    sessionStartRef.current = Date.now();
  };

  const endSession = async () => {
    if (!sessionStartRef.current || !activeBook) return;
    const elapsed = Date.now() - sessionStartRef.current;
    if (elapsed < 2000) return;

    if (activeBook.isLocal) {
      const bookId = activeBook.title.replace(/[^a-zA-Z0-9]/g, '_');
      const sessKey = `sess_local_${bookId}`;
      const existingSess = await localforage.getItem<Session[]>(sessKey) || [];
      const newSess = [...existingSess, { date: new Date().toISOString(), duration: elapsed }];
      await localforage.setItem(sessKey, newSess);
      
      setStats(prev => ({
        ...prev,
        [activeBook.title]: {
          ...(prev[activeBook.title] || { totalTime: 0, pagesRead: 0, sessions: [] }),
          sessions: newSess,
          totalTime: (prev[activeBook.title]?.totalTime || 0) + elapsed
        }
      }));
    } else if (user) {
      const bookId = activeBook.title.replace(/[^a-zA-Z0-9]/g, '_');
      const sessionsCol = collection(db, 'users', user.uid, 'books', bookId, 'sessions');
      const bookRef = doc(db, 'users', user.uid, 'books', bookId);

      try {
        await addDoc(sessionsCol, {
          date: serverTimestamp(),
          duration: elapsed
        });
        const currentBookStats = getBookStats(activeBook.title);
        await updateDoc(bookRef, {
          totalTime: currentBookStats.totalTime + elapsed,
          updatedAt: serverTimestamp()
        });
      } catch (e) {
        handleFirestoreError(e, OperationType.WRITE, `users/${user.uid}/books/${bookId}/sessions`);
      }
    }
    sessionStartRef.current = null;
  };

  const trackPageRead = async () => {
    if (!activeBook) return;
    if (activeBook.isLocal) {
      setStats(prev => ({
        ...prev,
        [activeBook.title]: {
          ...(prev[activeBook.title] || { totalTime: 0, pagesRead: 0, sessions: [] }),
          pagesRead: (prev[activeBook.title]?.pagesRead || 0) + 1
        }
      }));
    } else if (user) {
      const bookId = activeBook.title.replace(/[^a-zA-Z0-9]/g, '_');
      const bookRef = doc(db, 'users', user.uid, 'books', bookId);
      try {
        const currentBookStats = getBookStats(activeBook.title);
        await updateDoc(bookRef, {
          pagesRead: currentBookStats.pagesRead + 1,
          updatedAt: serverTimestamp()
        });
      } catch (e) {
        handleFirestoreError(e, OperationType.UPDATE, `users/${user.uid}/books/${bookId}`);
      }
    }
  };

  // --- STATE FOR COMPLEX RELATIONS ---
  const [currentBookBookmarks, setCurrentBookBookmarks] = useState<number[]>([]);
  const [currentChapterAnnotations, setCurrentChapterAnnotations] = useState<Annotation[]>([]);

  useEffect(() => {
    if (!activeBook || !activeBook.isLocal) return;
    const bookId = activeBook.title.replace(/[^a-zA-Z0-9]/g, '_');
    
    const loadLocalData = async () => {
      // Load bookmarks
      const bms = await localforage.getItem<number[]>(`bm_local_${bookId}`) || [];
      setCurrentBookBookmarks(bms);

      // Load annotations
      const anns = await localforage.getItem<Annotation[]>(`ann_local_${bookId}`) || [];
      const filteredAnns = anns.filter((a: any) => a.chapterIndex === currentCh);
      setCurrentChapterAnnotations(filteredAnns);

      // Load sessions if not already in stats
      if (!stats[activeBook.title]?.sessions.length) {
        const sesss = await localforage.getItem<Session[]>(`sess_local_${bookId}`) || [];
        setStats(prev => ({
          ...prev,
          [activeBook.title]: {
            ...(prev[activeBook.title] || { totalTime: 0, pagesRead: 0, sessions: [] }),
            sessions: sesss
          }
        }));
      }
    };
    loadLocalData();
  }, [activeBook, currentCh]);

  useEffect(() => {
    if (!user || !activeBook || activeBook.isLocal) {
      // Local bookmarks are handled by the separate local effect
      return;
    }
    const bookId = activeBook.title.replace(/[^a-zA-Z0-9]/g, '_');
    const bmRef = collection(db, 'users', user.uid, 'books', bookId, 'bookmarks');
    return onSnapshot(bmRef, (snap) => {
      const bms: number[] = [];
      snap.forEach(doc => bms.push(doc.data().chapterIndex));
      setCurrentBookBookmarks(bms.sort((a, b) => a - b));
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}/books/${bookId}/bookmarks`);
    });
  }, [user, activeBook]);

  useEffect(() => {
    if (!user || !activeBook || screen !== 'reader' || activeBook.isLocal) {
      return;
    }
    const bookId = activeBook.title.replace(/[^a-zA-Z0-9]/g, '_');
    const annRef = collection(db, 'users', user.uid, 'books', bookId, 'annotations');
    // We only care about current chapter annotations in this simplified version
    // But since subcollections are small, we can listen to all as well or filter
    return onSnapshot(annRef, (snap) => {
      const allAnn: Record<number, Annotation[]> = {};
      snap.forEach(doc => {
        const data = doc.data();
        if (!allAnn[data.chapterIndex]) allAnn[data.chapterIndex] = [];
        allAnn[data.chapterIndex].push({ 
          text: data.text, 
          date: data.date?.toDate?.()?.toISOString() || new Date().toISOString() 
        });
      });
      setCurrentChapterAnnotations(allAnn[currentCh] || []);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}/books/${bookId}/annotations`);
    });
  }, [user, activeBook, currentCh, screen]);

  // We also need to fetch sessions for stats
  useEffect(() => {
    if (!user || !activeBook || screen !== 'stats' || activeBook.isLocal) return;
    const bookId = activeBook.title.replace(/[^a-zA-Z0-9]/g, '_');
    const sessRef = collection(db, 'users', user.uid, 'books', bookId, 'sessions');
    return onSnapshot(sessRef, (snap) => {
      const sesss: Session[] = [];
      snap.forEach(doc => {
        const data = doc.data();
        sesss.push({
          date: data.date?.toDate?.()?.toISOString() || new Date().toISOString(),
          duration: data.duration
        });
      });
      setStats(prev => ({
        ...prev,
        [activeBook.title]: {
          ...(prev[activeBook.title] || { totalTime: 0, pagesRead: 0, sessions: [] }),
          sessions: sesss
        }
      }));
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}/books/${bookId}/sessions`);
    });
  }, [user, activeBook, screen]);

  const toggleBookmark = async () => {
    if (!activeBook) return;
    const bookId = activeBook.title.replace(/[^a-zA-Z0-9]/g, '_');

    if (activeBook.isLocal) {
      const bms = await localforage.getItem<number[]>(`bm_local_${bookId}`) || [];
      let updated;
      if (bms.includes(currentCh)) {
        updated = bms.filter(v => v !== currentCh);
      } else {
        updated = [...bms, currentCh].sort((a, b) => a - b);
      }
      await localforage.setItem(`bm_local_${bookId}`, updated);
      setCurrentBookBookmarks(updated);
      return;
    }

    if (!user) return;
    const bookmarkId = `bm_${currentCh}`;
    const bmRef = doc(db, 'users', user.uid, 'books', bookId, 'bookmarks', bookmarkId);
    
    try {
      if (currentBookBookmarks.includes(currentCh)) {
        await deleteDoc(bmRef);
      } else {
        await setDoc(bmRef, {
          chapterIndex: currentCh,
          createdAt: serverTimestamp()
        });
      }
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `users/${user.uid}/books/${bookId}/bookmarks/${bookmarkId}`);
    }
  };

  const saveAnnotation = async (text: string) => {
    if (!activeBook || !text.trim()) return;
    const bookId = activeBook.title.replace(/[^a-zA-Z0-9]/g, '_');

    if (activeBook.isLocal) {
      const anns = await localforage.getItem<Annotation[]>(`ann_local_${bookId}`) || [];
      const newAnn: any = { 
        text, 
        date: new Date().toISOString(), 
        chapterIndex: currentCh 
      };
      const updated = [...anns, newAnn];
      await localforage.setItem(`ann_local_${bookId}`, updated);
      setCurrentChapterAnnotations(prev => [...prev, newAnn]);
      setAnnotationText('');
      return;
    }

    if (!user) return;
    const annRef = collection(db, 'users', user.uid, 'books', bookId, 'annotations');
    try {
      await addDoc(annRef, {
        chapterIndex: currentCh,
        text,
        date: serverTimestamp()
      });
      setAnnotationText('');
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `users/${user.uid}/books/${bookId}/annotations`);
    }
  };

  const deleteAnnotation = async (indexInCurrent: number) => {
    if (!activeBook) return;
    const bookId = activeBook.title.replace(/[^a-zA-Z0-9]/g, '_');

    if (activeBook.isLocal) {
      const anns = await localforage.getItem<Annotation[]>(`ann_local_${bookId}`) || [];
      const chapterAnns = anns.filter((a: any) => a.chapterIndex === currentCh);
      const noteToDelete = chapterAnns[indexInCurrent];
      if (noteToDelete) {
        const updated = anns.filter(a => a !== noteToDelete);
        await localforage.setItem(`ann_local_${bookId}`, updated);
        setCurrentChapterAnnotations(prev => prev.filter((_, i) => i !== indexInCurrent));
      }
      return;
    }

    if (!user) return;
    const annRef = collection(db, 'users', user.uid, 'books', bookId, 'annotations');
    try {
      // This is a bit inefficient without document IDs stored in annotations state
      // For a better implementation, we'd store doc IDs. Let's just fetch and delete by index for now as a naive fix or just store ids.
      // Re-querying is safer.
      const q = query(annRef);
      const snap = await getDocs(q);
      const match = snap.docs.filter(d => d.data().chapterIndex === currentCh)[indexInCurrent];
      if (match) {
        await deleteDoc(match.ref);
      }
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `users/${user.uid}/books/${bookId}/annotations`);
    }
  };

  const deleteBook = async (book: SavedBook, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Delete "${book.title}" from your library?`)) {
      const bookId = book.title.replace(/[^a-zA-Z0-9]/g, '_');
      
      if (book.isLocal) {
        // Handle local deletion
        await localforage.removeItem(`bin_local_${bookId}`);
        const current = await localforage.getItem<SavedBook[]>('local_books_metadata') || [];
        const filtered = current.filter(b => b.title !== book.title);
        await localforage.setItem('local_books_metadata', filtered);
        setLocalBooks(prev => prev.filter(b => b.title !== book.title));
      } else if (user) {
        const bookRef = doc(db, 'users', user.uid, 'books', bookId);
        try {
          await deleteDoc(bookRef);
          await localforage.removeItem(`bin_${bookId}`);
        } catch (e) {
          handleFirestoreError(e, OperationType.DELETE, `users/${user.uid}/books/${bookId}`);
        }
      }

      if (activeBook?.title === book.title) {
        setActiveBook(null);
        setScreen('library');
      }
    }
  };

  const renderCalendar = () => {
    const start = startOfMonth(calendarViewDate);
    const end = endOfMonth(calendarViewDate);
    const days = eachDayOfInterval({ start, end });
    const startDay = getDay(start);

    const prevMonth = () => setCalendarViewDate(prev => subMonths(prev, 1));
    const nextMonth = () => setCalendarViewDate(prev => {
      const next = new Date(prev);
      next.setMonth(next.getMonth() + 1);
      return next;
    });

    return renderLayout(
      <div className="flex-1 overflow-y-auto p-4 sm:p-8 custom-scrollbar">
        <header className="mb-12">
          <div className="flex items-center gap-4 mb-4">
            <button 
              onClick={() => setScreen('home')}
              className="p-2 bg-brand-primary text-brand-text-heading rounded-full shadow-lg hover:scale-110 transition-transform"
            >
              <ArrowLeft size={18} />
            </button>
            <span className="text-[10px] font-bold text-brand-text-heading/40 uppercase tracking-[0.2em]">Dashboard</span>
          </div>
          <h2 className="text-4xl font-serif font-bold text-brand-text-heading tracking-tight mb-2 uppercase">READING CALENDAR</h2>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-[0.3em] opacity-40">Timeline of Literary Intake</p>
        </header>

        <div className="bg-brand-card p-6 sm:p-12 rounded-[40px] border border-brand-border shadow-xl">
          <div className="flex items-center justify-between mb-12">
             <div className="flex flex-col">
               <span className="text-3xl font-serif font-bold text-brand-text-heading">{format(calendarViewDate, 'MMMM')}</span>
               <span className="text-sm font-bold text-brand-primary tracking-[0.5em] uppercase">{format(calendarViewDate, 'yyyy')}</span>
             </div>
             <div className="flex items-center gap-2">
                <button onClick={prevMonth} className="p-3 bg-brand-bg hover:bg-brand-primary transition-colors rounded-full border border-brand-border shadow-sm"><ChevronLeft size={20} /></button>
                <button onClick={nextMonth} className="p-3 bg-brand-bg hover:bg-brand-primary transition-colors rounded-full border border-brand-border shadow-sm"><ChevronRight size={20} /></button>
             </div>
          </div>

          <div className="grid grid-cols-7 gap-px bg-brand-border/30 rounded-3xl overflow-hidden border border-brand-border/30">
            {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d) => (
              <div key={d} className="bg-brand-bg/10 p-4 text-center text-[10px] font-bold text-brand-text-heading/30 uppercase tracking-[0.2em] border-b border-brand-border/30">
                <span className="hidden sm:inline">{d}</span>
                <span className="sm:hidden">{d.charAt(0)}</span>
              </div>
            ))}

            {Array.from({ length: startDay }).map((_, i) => (
              <div key={`empty-${i}`} className="bg-brand-bg/5 min-h-[100px] sm:min-h-[140px]"></div>
            ))}

            {days.map((day) => {
              const key = format(day, 'yyyy-MM-dd');
              const data = activityData[key];
              const isCurrentDay = isToday(day);

              return (
                <div key={key} className={`bg-white min-h-[100px] sm:min-h-[140px] p-2 sm:p-4 flex flex-col transition-all border-b border-r border-brand-border/10 ${data ? 'hover:bg-brand-primary/5 cursor-pointer' : ''} ${isCurrentDay ? 'relative' : ''}`}>
                  {isCurrentDay && <div className="absolute top-2 right-2 w-2 h-2 bg-brand-primary rounded-full shadow-lg animate-pulse"></div>}
                  <span className={`text-xs font-bold ${isCurrentDay ? 'text-brand-primary' : 'text-brand-text-heading/40'}`}>
                    {format(day, 'd')}
                  </span>
                  
                  {data && (
                    <div className="mt-2 flex flex-col gap-1.5 overflow-hidden">
                      <div className="flex flex-wrap gap-1">
                        {Array.from(data.titles).map((title, i) => (
                          <div key={i} className="group/book relative">
                            <div className="w-6 h-8 bg-brand-primary/20 rounded-[2px] border border-brand-primary/30 flex items-center justify-center' shadow-sm">
                              <Book size={12} className="text-brand-primary" />
                            </div>
                            {/* Hover info for the specific book */}
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover/book:block z-50">
                               <div className="bg-brand-text-heading text-white text-[9px] font-bold px-3 py-2 rounded-lg shadow-2xl whitespace-nowrap">
                                 {title}
                               </div>
                               <div className="w-1.5 h-1.5 bg-brand-text-heading rotate-45 mx-auto -mt-1"></div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <span className="text-[9px] font-bold text-brand-primary uppercase mt-auto">
                        {formatTime(data.duration)}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  useEffect(() => {
    const handleQuota = () => setQuotaExceeded(true);
    window.addEventListener('firestore-quota-exceeded', handleQuota);
    return () => window.removeEventListener('firestore-quota-exceeded', handleQuota);
  }, []);

  const renderQuotaNotice = () => (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-brand-text-heading/90 backdrop-blur-sm p-4 text-center">
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="max-w-md bg-white rounded-[32px] p-8 shadow-2xl"
      >
        <div className="w-16 h-16 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-6">
          <AlertCircle size={32} />
        </div>
        <h3 className="text-2xl font-serif font-bold text-brand-text-heading mb-4 uppercase tracking-tight">Database at Capacity</h3>
        <p className="text-slate-600 text-sm mb-6 leading-relaxed">
          The application has reached its free daily database quota. This is a temporary limit that resets every 24 hours.
        </p>
        <div className="bg-slate-50 rounded-2xl p-4 mb-8 text-xs text-slate-500 font-mono">
          Reset expected at midnight (UTC)
        </div>
        <button 
          onClick={() => setQuotaExceeded(false)}
          className="w-full py-4 bg-brand-primary text-brand-text-heading font-bold rounded-full shadow-lg hover:brightness-110 transition-all"
        >
          Dismiss
        </button>
        <p className="mt-4 text-[10px] text-slate-400">
          Learn more at <a href="https://firebase.google.com/pricing" target="_blank" rel="noreferrer" className="underline">firebase.google.com/pricing</a>
        </p>
      </motion.div>
    </div>
  );

  const renderLayout = (content: React.ReactNode) => (
    <div className="flex h-screen bg-brand-bg overflow-hidden font-sans relative">
      {/* Sidebar - Hidden on mobile */}
      <aside className="w-64 bg-brand-text-heading flex flex-col text-slate-400 hidden lg:flex">
        <div className="p-8 flex items-center gap-3">
          <h1 className="text-white font-serif font-bold text-2xl tracking-tighter italic">LITVERSE</h1>
        </div>
        <nav className="flex-1 px-6 py-4 space-y-4 text-sm">
          <div 
            onClick={() => setScreen('home')}
            className={`px-4 py-3 rounded-[12px] flex items-center gap-3 cursor-pointer transition-all ${screen === 'home' ? 'bg-brand-primary text-brand-text-heading font-medium shadow-lg shadow-brand-primary/10' : 'hover:bg-white/5'}`}
          >
            <BarChart2 size={18} />
            <span>Dashboard</span>
          </div>
          <div 
            onClick={() => setScreen('library')}
            className={`px-4 py-3 rounded-[12px] flex items-center gap-3 cursor-pointer transition-all ${screen === 'library' ? 'bg-brand-primary text-brand-text-heading font-medium shadow-lg shadow-brand-primary/10' : 'hover:bg-white/5'}`}
          >
            <Library size={18} />
            <span>Library</span>
          </div>
          <div 
            onClick={() => setScreen('upload')}
            className={`px-4 py-3 rounded-[12px] flex items-center gap-3 cursor-pointer transition-all ${screen === 'upload' ? 'bg-brand-primary text-brand-text-heading font-medium shadow-lg shadow-brand-primary/10' : 'hover:bg-white/5'}`}
          >
            <Plus size={18} />
            <span>Upload New</span>
          </div>
        </nav>
        <div className="p-8 border-t border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-[16px] bg-brand-primary/20 flex items-center justify-center text-xs font-bold text-white shadow-inner border border-white/10 overflow-hidden">
              {user ? (
                user.photoURL ? <img src={user.photoURL} alt="" className="w-full h-full object-cover" /> : user.displayName?.charAt(0) || 'U'
              ) : (
                <UserCircle size={18} className="text-white/40" />
              )}
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-bold text-white truncate w-32">{user ? (user.displayName || user.email) : 'Guest Sector'}</span>
              {user ? (
                <button 
                  onClick={() => signOut(auth)}
                  className="text-[10px] text-slate-500 font-bold uppercase tracking-widest hover:text-brand-primary text-left flex items-center gap-1 transition-colors mt-0.5"
                >
                  <LogOut size={8} /> Sign Out
                </button>
              ) : (
                <button 
                  onClick={() => signInWithPopup(auth, googleProvider)}
                  className="text-[10px] text-brand-primary font-bold uppercase tracking-widest hover:underline text-left flex items-center gap-1 transition-colors mt-0.5"
                >
                  <LogIn size={8} /> Authenticate
                </button>
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile Bottom Nav */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 h-16 bg-brand-text-heading border-t border-white/5 flex items-center justify-around px-6 z-50">
        <button 
          onClick={() => setScreen('home')}
          className={`flex flex-col items-center gap-1 ${screen === 'home' ? 'text-brand-primary' : 'text-slate-400'}`}
        >
          <BarChart2 size={20} />
          <span className="text-[9px] font-bold uppercase tracking-widest">Dash</span>
        </button>
        <button 
          onClick={() => setScreen('library')}
          className={`flex flex-col items-center gap-1 ${screen === 'library' ? 'text-brand-primary' : 'text-slate-400'}`}
        >
          <Library size={20} />
          <span className="text-[9px] font-bold uppercase tracking-widest">Library</span>
        </button>
        <button 
          onClick={() => setScreen('upload')}
          className={`flex flex-col items-center gap-1 ${screen === 'upload' ? 'text-brand-primary' : 'text-slate-400'}`}
        >
          <Plus size={20} />
          <span className="text-[9px] font-bold uppercase tracking-widest">Import</span>
        </button>
      </nav>

      <main className="flex-1 flex flex-col overflow-hidden pb-16 lg:pb-0">
        {content}
      </main>
    </div>
  );

  const getChapterTitle = (path: string) => {
    if (!path) return 'Untitled Fragment';
    return decodeURIComponent(path.split('/').pop()!.replace(/\.x?html?$/i, '').replace(/[_-]/g, ' '));
  };

  const renderHome = () => renderLayout(
    <div className="flex-1 overflow-y-auto p-8 custom-scrollbar relative">
      <header className="mb-12 flex justify-between items-center">
        <h2 className="text-2xl font-serif font-bold text-brand-text-heading tracking-tight uppercase">BOOKSHELF</h2>
        <button 
          onClick={() => setScreen('upload')}
          className="p-3 bg-brand-primary text-brand-text-heading rounded-full shadow-lg hover:scale-110 transition-transform lg:hidden"
          title="Add Book"
        >
          <Plus size={20} />
        </button>
      </header>

      {renderActivityCalendar()}

      <div className="mt-12">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3 text-sm font-bold text-brand-text-heading/60 tracking-widest uppercase">
            <div className="w-12 h-[1px] bg-brand-border"></div>
            Last Detected Fragment
          </div>
          <button 
            onClick={() => setScreen('library')}
            className="text-[10px] font-bold text-brand-primary uppercase tracking-widest hover:underline"
          >
            BOOKSHELF →
          </button>
        </div>

        {lastReadBook ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div 
              onClick={() => openBook(lastReadBook)}
              className="group bg-brand-card border border-brand-border rounded-[32px] p-8 flex gap-8 items-center cursor-pointer hover:shadow-2xl hover:-translate-y-2 transition-all duration-500"
            >
              {lastReadBook.coverUrl ? (
                <img src={lastReadBook.coverUrl} className="w-32 h-44 object-cover rounded-[16px] shadow-xl group-hover:rotate-3 transition-transform duration-500" alt={lastReadBook.title} />
              ) : (
                <div className="w-32 h-44 bg-brand-primary/10 rounded-[16px] flex items-center justify-center border border-brand-border">
                  <Book size={32} className="text-brand-primary/40" />
                </div>
              )}
              <div className="flex-1">
                <h3 className="text-2xl font-serif font-bold text-brand-text-heading mb-3 line-clamp-2">{lastReadBook.title}</h3>
                
                {(() => {
                  const s = getBookStats(lastReadBook.title);
                  return (
                    <div className="flex items-center gap-4 mb-6">
                      <div className="flex flex-col">
                        <span className="text-[9px] font-bold text-brand-primary uppercase tracking-widest">Recorded Time</span>
                        <span className="text-sm font-bold text-brand-text-heading">{formatTime(s.totalTime)}</span>
                      </div>
                      <div className="w-[1px] h-6 bg-brand-border"></div>
                      <div className="flex flex-col">
                        <span className="text-[9px] font-bold text-brand-primary uppercase tracking-widest">Fragments Read</span>
                        <span className="text-sm font-bold text-brand-text-heading">{s.pagesRead}</span>
                      </div>
                    </div>
                  );
                })()}

                <div className="w-full h-2 bg-brand-bg rounded-full overflow-hidden mb-4">
                  <div 
                    className="h-full bg-brand-primary transition-all duration-700" 
                    style={{ width: `${((lastReadBook.currentCh + 1) / lastReadBook.chapters.length) * 100}%` }}
                  ></div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-[10px] font-bold text-brand-text-heading/30 uppercase tracking-widest">
                      Fragment {lastReadBook.currentCh + 1} of {lastReadBook.chapters.length}
                    </span>
                    <button 
                      onClick={(e) => { e.stopPropagation(); openBook(lastReadBook); }}
                      className="mt-2 flex items-center gap-2 text-[10px] font-bold text-brand-primary uppercase tracking-widest hover:underline"
                    >
                      Continue Reading <ArrowRight size={12} />
                    </button>
                  </div>
                  <button 
                    onClick={(e) => { e.stopPropagation(); setActiveBook(lastReadBook); setScreen('stats'); }}
                    className="w-8 h-8 rounded-full bg-brand-primary text-brand-text-heading flex items-center justify-center shadow-lg shadow-brand-primary/20 hover:scale-110 transition-transform"
                  >
                    <BarChart2 size={14} className="rotate-90" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-brand-card/50 border border-brand-border border-dashed rounded-[32px] p-20 text-center">
             <Library size={48} className="mx-auto mb-4 text-brand-text-heading/10" />
             <p className="text-sm font-bold text-brand-text-heading/30 uppercase tracking-[0.2em] mb-6">No fragments uploaded to this sector.</p>
             <button 
                onClick={() => setScreen('upload')}
                className="px-8 py-3 bg-brand-primary text-brand-text-heading rounded-full font-bold shadow-lg hover:scale-105 transition-transform"
             >
                Add Your First Book
             </button>
          </div>
        )}
      </div>
    </div>
  );

  const renderUpload = () => renderLayout(
    <div className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-brand-bg relative overflow-y-auto custom-scrollbar">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md py-12"
      >
        <div className="flex items-center justify-center w-16 h-16 mx-auto mb-6 bg-brand-primary rounded-[24px] text-white shadow-xl shadow-brand-primary/20">
          <Book size={32} />
        </div>
        <h1 className="text-3xl font-bold text-brand-text-heading mb-2 tracking-tight">Pocket Library</h1>
        <p className="text-slate-500 mb-10 text-sm">Professional reading tracking and annotation system.</p>
        
        {!user ? (
          <div className="flex flex-col gap-6">
            <div className="bg-brand-card p-8 rounded-[24px] border border-brand-border shadow-sm flex flex-col gap-6">
              <h2 className="text-sm font-bold text-brand-text-heading uppercase tracking-widest text-brand-primary">SECURE ARCHIVE</h2>
              <p className="text-xs text-slate-500 font-medium leading-relaxed">Sign in with Google to enable cross-device synchronization and secure cloud storage for your reading history.</p>
              <button 
                onClick={loginWithGoogle}
                className="flex items-center justify-center gap-3 bg-brand-primary text-brand-text-heading py-4 rounded-[24px] font-bold hover:brightness-105 transition-all shadow-xl shadow-brand-primary/20"
              >
                <LogIn size={18} /> Authenticate
              </button>
            </div>
            
            <div className="relative py-4">
              <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-brand-border"></div></div>
              <div className="relative flex justify-center text-[10px] font-bold uppercase tracking-[0.4em]"><span className="bg-brand-bg px-4 text-slate-400">Offline Access</span></div>
            </div>

            <label className={`group relative block w-full aspect-video border border-brand-border rounded-[24px] bg-white shadow-sm hover:border-brand-primary hover:shadow-md transition-all ${isImporting ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} overflow-hidden p-8`}>
              <input 
                type="file" 
                accept=".epub" 
                className="sr-only" 
                disabled={isImporting}
                onChange={(e) => e.target.files?.[0] && loadEpub(e.target.files[0], true)} 
              />
              <div className="flex flex-col items-center justify-center h-full gap-4">
                {isImporting ? (
                  <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-brand-primary/20 border-t-brand-primary rounded-full animate-spin"></div>
                    <div className="text-sm font-bold text-brand-primary uppercase tracking-widest animate-pulse">Scanning Fragment...</div>
                  </div>
                ) : (
                  <>
                    <div className="w-12 h-12 bg-brand-bg rounded-2xl flex items-center justify-center group-hover:bg-brand-primary/10 transition-colors">
                      <Plus size={24} className="text-brand-text-heading/40 group-hover:text-brand-primary" />
                    </div>
                    <div className="text-sm font-medium text-slate-600">
                      Import to <span className="text-brand-primary font-bold">Local Sector</span>
                    </div>
                  </>
                )}
              </div>
            </label>
            {displayedBooks.length > 0 && (
              <button 
                onClick={() => setScreen('library')}
                className="mt-4 px-8 py-3.5 text-[10px] font-bold text-brand-primary uppercase tracking-widest hover:underline"
              >
                Enter Library →
              </button>
            )}
          </div>
        ) : (
          <>
            {importError && (
              <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-[16px] text-red-600 text-xs font-medium flex items-center gap-3">
                <X size={16} className="shrink-0 cursor-pointer" onClick={() => setImportError(null)} />
                <span className="text-left">{importError}</span>
              </div>
            )}
            
            <div className="grid grid-cols-1 gap-6">
              <label className={`group relative block w-full aspect-video border border-brand-primary/20 border-dashed rounded-[24px] bg-brand-primary/5 shadow-sm hover:border-brand-primary hover:bg-brand-primary/10 transition-all ${isImporting ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} overflow-hidden p-8`}>
                <input 
                  type="file" 
                  accept=".epub" 
                  className="sr-only" 
                  disabled={isImporting}
                  onChange={(e) => e.target.files?.[0] && loadEpub(e.target.files[0], false)} 
                />
                <div className="flex flex-col items-center justify-center h-full gap-4">
                  {isImporting ? (
                    <div className="flex flex-col items-center gap-4">
                      <div className="w-12 h-12 border-4 border-brand-primary/40 border-t-brand-primary rounded-full animate-spin"></div>
                      <div className="text-sm font-bold text-brand-primary uppercase tracking-widest animate-pulse">Syncing to Cloud...</div>
                    </div>
                  ) : (
                    <>
                      <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">
                        <Plus size={24} className="text-brand-primary" />
                      </div>
                      <div className="text-sm font-bold text-brand-primary uppercase tracking-widest">
                        Cloud Upload & Sync
                      </div>
                    </>
                  )}
                </div>
              </label>

              <label className={`group relative block w-full border border-brand-border rounded-[24px] bg-white py-6 px-8 shadow-sm hover:border-brand-primary hover:shadow-md transition-all ${isImporting ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                <input 
                  type="file" 
                  accept=".epub" 
                  className="sr-only" 
                  disabled={isImporting}
                  onChange={(e) => e.target.files?.[0] && loadEpub(e.target.files[0], true)} 
                />
                <div className="flex items-center gap-6">
                  <div className="w-12 h-12 bg-brand-bg rounded-xl flex items-center justify-center group-hover:bg-brand-primary/10 transition-colors">
                    <Download size={20} className="text-brand-text-heading/40 group-hover:text-brand-primary" />
                  </div>
                  <div className="flex-1 text-left">
                    <div className="text-sm font-bold text-brand-text-heading uppercase tracking-widest">
                      Local Import
                    </div>
                    <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Stays on this device only</div>
                  </div>
                </div>
              </label>
            </div>
            
            <div className="flex gap-4 mt-8">
              {displayedBooks.length > 0 && (
                <button 
                  onClick={() => setScreen('library')}
                  className="flex-1 py-4 bg-brand-card border border-brand-border text-[10px] font-bold uppercase tracking-widest text-brand-text-heading hover:text-brand-primary hover:border-brand-primary/30 flex items-center justify-center gap-2 rounded-[24px] transition-all shadow-sm"
                >
                  <Library size={14} /> Bookshelf
                </button>
              )}
              <button 
                onClick={() => signOut(auth)}
                className="flex-1 py-4 bg-brand-text-heading text-white text-[10px] font-bold uppercase tracking-widest flex items-center justify-center gap-2 rounded-[24px] hover:opacity-90 transition-all shadow-sm"
              >
                <LogOut size={14} /> Log Out
              </button>
            </div>
          </>
        )}
      </motion.div>
    </div>
  );

  const renderLibrary = () => renderLayout(
    <div className="flex-1 overflow-y-auto custom-scrollbar bg-[url('https://www.transparenttextures.com/patterns/wood-pattern.png')] bg-repeat bg-[#e0d5c4]">
      <div className="min-h-full p-4 sm:p-8 backdrop-blur-[2px] bg-white/10">
        <header className="mb-12 relative z-10">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <button 
                onClick={() => setScreen('home')}
                className="p-2 bg-brand-primary text-brand-text-heading rounded-full shadow-lg hover:scale-110 transition-transform"
              >
                <ArrowLeft size={18} />
              </button>
              <span className="text-[10px] font-bold text-brand-text-heading/40 uppercase tracking-[0.2em]">Return Home</span>
            </div>
            <button 
              onClick={() => setScreen('upload')}
              className="p-3 bg-brand-primary text-brand-text-heading rounded-full shadow-lg hover:scale-110 transition-transform lg:hidden"
              title="Add Book"
            >
              <Plus size={20} />
            </button>
          </div>
          <h2 className="text-4xl font-serif font-bold text-brand-text-heading tracking-tight mb-2 uppercase">BOOKSHELF</h2>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-[0.3em] opacity-40">System-wide Book Collection</p>
        </header>
        
        <div className="relative">
          {/* Decorative Shelves Background Decor */}
          <div className="absolute inset-0 z-0 pointer-events-none hidden lg:block" 
               style={{ backgroundImage: 'linear-gradient(to bottom, transparent 360px, rgba(101, 67, 33, 0.4) 360px, rgba(139, 94, 60, 0.8) 365px, rgba(101, 67, 33, 0.4) 375px, transparent 375px)', backgroundSize: '100% 420px' }}>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-y-24 gap-x-8 sm:gap-x-12 px-2 sm:px-4 pb-20 relative z-10">
            {displayedBooks.map((book, i) => {
               const s = getBookStats(book.title);
               const progress = Math.min(100, ((book.currentCh + 1) / book.chapters.length) * 100);
               
               return (
                 <div key={`${book.title}-${i}`} className="relative group flex flex-col items-center">
                   <motion.div 
                     whileHover={{ z: 20, rotateY: -15, scale: 1.05 }}
                     transition={{ type: 'spring', stiffness: 300, damping: 25 }}
                     onClick={() => openBook(book)}
                     className="relative aspect-[2/3] w-full rounded-r-[4px] rounded-l-[1px] overflow-hidden cursor-pointer shadow-[15px_15px_30px_-10px_rgba(0,0,0,0.5)] group-hover:shadow-[20px_20px_40px_-10px_rgba(0,0,0,0.6)] transition-all bg-brand-card flex"
                   >
                     {/* Spine Detail */}
                     <div className="w-[12px] h-full bg-black/20 shrink-0 border-r border-black/10 z-10"></div>
                     
                     <div className="flex-1 relative h-full">
                        {book.coverUrl ? (
                          <img src={book.coverUrl} className="w-full h-full object-cover" alt={book.title} />
                        ) : (
                          <div className="w-full h-full bg-brand-card flex flex-col items-center justify-center p-6 border-y border-r border-brand-border/20">
                            <Book size={24} className="text-brand-primary mb-4 opacity-30" />
                            <span className="text-[9px] font-bold text-center text-brand-text-heading/40 uppercase tracking-tighter leading-tight line-clamp-3">{book.title}</span>
                          </div>
                        )}
                        
                        {book.isLocal && (
                          <div className="absolute top-2 right-2 z-30">
                            <span className="bg-brand-primary text-brand-text-heading text-[8px] font-bold px-2 py-0.5 rounded-full shadow-sm">LOCAL</span>
                          </div>
                        )}
                        
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/20">
                           <div className="h-full bg-brand-primary" style={{ width: `${progress}%` }}></div>
                        </div>

                        <div className="absolute inset-0 bg-brand-text-heading/80 opacity-0 group-hover:opacity-100 transition-all flex flex-col items-center justify-center p-4 text-center z-20">
                           <div className="flex gap-3">
                             <button 
                               onClick={(e) => { e.stopPropagation(); setActiveBook(book); setScreen('stats'); }}
                               className="p-2.5 bg-white/10 hover:bg-brand-primary text-white rounded-full transition-all"
                               title="View Stats"
                             >
                               <BarChart2 size={12} className="rotate-90" />
                             </button>
                             <button 
                               onClick={(e) => deleteBook(book, e)}
                               className="p-2.5 bg-white/10 hover:bg-brand-primary text-white rounded-full transition-all"
                             >
                               <Trash2 size={12} />
                             </button>
                           </div>
                        </div>
                     </div>
                   </motion.div>

                   {/* Shelf Slab below the book */}
                   <div className="w-[120%] h-3 bg-gradient-to-b from-[#8b5e3c] to-[#5d3a1a] shadow-lg rounded-[2px] -mt-2 mb-4 relative z-0">
                      <div className="absolute inset-x-0 bottom-full h-2 bg-black/10 blur-[1px]"></div>
                   </div>

                   <div className="px-1 text-center max-w-full">
                     <h4 className="text-[11px] font-serif font-bold text-brand-text-heading/80 truncate mb-1">{book.title}</h4>
                     <div className="flex items-center justify-center gap-3">
                       <span className="text-[8px] font-bold text-brand-text-heading/40 uppercase tracking-widest">{s.pagesRead} FRAG</span>
                       <div className="w-[1px] h-2 bg-brand-text-heading/10"></div>
                       <span className="text-[8px] font-bold text-brand-primary uppercase tracking-widest">{formatTime(s.totalTime)}</span>
                     </div>
                   </div>
                 </div>
               );
            })}
          </div>
        </div>
      </div>
    </div>
  );

  const renderOldLibrary = () => (
    <div className="flex h-screen bg-brand-bg overflow-hidden">
      {/* Aside mimicking the Professional theme */}
      <aside className="w-64 bg-brand-text-heading flex flex-col text-slate-400 hidden lg:flex">
        <div className="p-8 flex items-center gap-3">
          <div className="w-10 h-10 bg-brand-primary rounded-[18px] flex items-center justify-center shadow-lg shadow-brand-primary/20">
            <Book size={20} className="text-white" />
          </div>
          <span className="text-white font-bold text-xl tracking-tight">Pocket Library</span>
        </div>
        <nav className="flex-1 px-6 py-4 space-y-2 text-sm">
          <div className="bg-brand-primary text-brand-text-heading px-4 py-2.5 rounded-[12px] flex items-center gap-3 cursor-pointer shadow-md shadow-brand-primary/10">
            <Library size={18} />
            <span className="font-bold">Library</span>
          </div>
          <div 
            onClick={() => setScreen('upload')}
            className="px-4 py-2.5 hover:bg-white/5 rounded-[12px] flex items-center gap-3 cursor-pointer transition-colors"
          >
            <Plus size={18} />
            <span className="font-medium">Upload New</span>
          </div>
        </nav>
        <div className="p-8 border-t border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-[16px] bg-brand-primary/20 flex items-center justify-center text-xs font-bold text-white shadow-inner border border-white/10 overflow-hidden">
              {user ? (
                user.photoURL ? <img src={user.photoURL} alt="" className="w-full h-full object-cover" /> : user.displayName?.charAt(0) || 'U'
              ) : (
                <UserCircle size={18} className="text-white/40" />
              )}
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-bold text-white truncate w-32">{user ? (user.displayName || user.email) : 'Guest Sector'}</span>
              {user ? (
                <button 
                  onClick={() => signOut(auth)}
                  className="text-[10px] text-slate-500 font-bold uppercase tracking-widest hover:text-brand-primary text-left flex items-center gap-1 transition-colors mt-0.5"
                >
                  <LogOut size={8} /> Sign Out
                </button>
              ) : (
                <button 
                  onClick={() => signInWithPopup(auth, googleProvider)}
                  className="text-[10px] text-brand-primary font-bold uppercase tracking-widest hover:underline text-left flex items-center gap-1 transition-colors mt-0.5"
                >
                  <LogIn size={8} /> Authenticate
                </button>
              )}
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-20 bg-transparent flex items-center justify-between px-8">
          <div className="flex flex-col">
            <h2 className="text-2xl font-bold text-brand-text-heading tracking-tight">Hi, {user?.displayName?.split(' ')[0] || 'Reader'}!</h2>
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest opacity-60">System Library Archives</p>
          </div>
          <div className="flex items-center gap-4">
            {/* Pill-shaped Search Bar */}
            <div className="relative hidden md:block">
              <input 
                type="text" 
                placeholder="Search for books..." 
                className="w-64 bg-brand-card border border-brand-border rounded-full py-2.5 px-6 text-sm text-brand-text-heading placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-primary/20 transition-all"
              />
              <div className="absolute right-2 top-1.5 p-1.5 bg-brand-primary rounded-full text-white shadow-sm">
                <BarChart2 size={14} className="rotate-90" />
              </div>
            </div>

            <label className="bg-brand-primary text-brand-text-heading p-3 rounded-full shadow-lg shadow-brand-primary/20 hover:opacity-90 cursor-pointer transition-all flex items-center justify-center">
              <Plus size={20} />
              <input 
                type="file" 
                accept=".epub" 
                className="hidden" 
                onChange={(e) => e.target.files?.[0] && loadEpub(e.target.files[0])} 
              />
            </label>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-8 custom-scrollbar">
          {renderActivityCalendar()}
          
          <div className="flex items-center gap-2 mb-10">
            <div className="w-1.5 h-1.5 bg-brand-primary rounded-full shadow-[0_0_8px_rgba(230,90,90,0.5)]"></div>
            <h3 className="font-bold text-brand-text-heading text-sm tracking-wide">Archived Collection</h3>
          </div>
          
          {/* Bookshelf Layout */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-y-20 gap-x-8 sm:gap-x-12 px-2 sm:px-4 pb-20">
            {displayedBooks.map((book, i) => {
               const s = getBookStats(book.title);
               const progress = Math.min(100, ((book.currentCh + 1) / book.chapters.length) * 100);
               
               return (
                 <div key={`${book.title}-${i}`} className="relative group">
                  {/* The Book */}
                  <motion.div 
                    whileHover={{ y: -12, rotateY: -12, translateZ: 30 }}
                    transition={{ type: "spring", stiffness: 300, damping: 20 }}
                    onClick={() => openBook(book)}
                    className="relative aspect-[3/4.5] cursor-pointer preserve-3d shadow-[15px_15px_30px_-5px_rgba(0,0,0,0.2)] group-hover:shadow-[25px_25px_45px_-10px_rgba(0,0,0,0.25)] transition-all duration-500 rounded-r-[4px] overflow-hidden bg-white"
                    style={{ perspective: '1000px' }}
                  >
                    {/* Spine Shadow Effect */}
                    <div className="absolute left-0 top-0 bottom-0 w-[6%] bg-gradient-to-r from-black/20 via-black/5 to-transparent z-10"></div>
                    
                    {/* Realistic Edge Highlights */}
                    <div className="absolute inset-0 border-l border-white/10 z-20"></div>
                    
                    {book.coverUrl ? (
                      <img 
                        src={book.coverUrl} 
                        alt={book.title} 
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="w-full h-full bg-brand-bg/50 flex flex-col items-center justify-center p-4 text-center">
                        <Book size={32} className="text-brand-text-heading/20 mb-2" />
                        <span className="text-[10px] font-bold text-brand-text-heading/40 uppercase tracking-tighter line-clamp-3 leading-tight">{book.title}</span>
                      </div>
                    )}

                    {book.isLocal && (
                      <div className="absolute top-2 right-2 z-40 bg-brand-primary text-brand-text-heading text-[8px] font-bold px-2 py-0.5 rounded-full shadow-sm">
                        LOCAL
                      </div>
                    )}

                    {/* Bookmark Ribbon */}
                    {currentBookBookmarks.includes(book.currentCh) && (
                      <div className="absolute top-0 right-3 w-3 h-6 bg-brand-primary shadow-sm z-30">
                        <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-white" style={{ clipPath: 'polygon(0 0, 50% 100%, 100% 0)' }}></div>
                      </div>
                    )}

                    {/* Progress Overlay (Subtle) */}
                    <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/10 z-30 overflow-hidden">
                      <div 
                        className="h-full bg-brand-primary shadow-[0_0_8px_rgba(230,90,90,0.4)] transition-all duration-1000" 
                        style={{ width: `${progress}%` }}
                      ></div>
                    </div>
                    
                    {/* Hover Info Panel */}
                    <div className="absolute inset-0 bg-brand-text-heading/90 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col items-center justify-center p-6 text-center z-40">
                      <span className="text-white text-[11px] font-bold uppercase tracking-widest mb-1.5 leading-tight line-clamp-2">{book.title}</span>
                      <div className="flex flex-col gap-1 mb-6">
                        <span className="text-brand-primary text-[10px] font-bold">{Math.round(progress)}% READ</span>
                        <span className="text-white/30 text-[8px] font-mono uppercase tracking-widest">{formatTime(s.totalTime)}</span>
                      </div>
                      <div className="flex gap-2">
                        <button 
                          onClick={(e) => deleteBook(book, e)}
                          className="p-2.5 bg-white/10 hover:bg-brand-primary hover:text-brand-text-heading text-white rounded-full transition-all"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  </motion.div>

                  {/* Shelf Platform Underneath */}
                  <div className="absolute -bottom-6 left-[-15%] right-[-15%] h-3.5 bg-[#5D4E41] shadow-[0_12px_24px_-8px_rgba(0,0,0,0.4)] rounded-sm z-0">
                    <div className="absolute inset-0 bg-gradient-to-b from-white/5 to-transparent"></div>
                    <div className="absolute bottom-[-10px] left-[5%] right-[5%] h-[10px] bg-black/15 blur-md"></div>
                  </div>

                  {/* Recognition Metadata underneath shelf */}
                  <div className="absolute -bottom-16 left-0 right-0 text-center opacity-70 group-hover:opacity-100 transition-opacity">
                    <h4 className="text-[10px] font-bold text-brand-text-heading truncate px-2">{book.title}</h4>
                    <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest">Frag. {book.chapters.length}</p>
                  </div>

                  {/* Reflection/Shadow on Shelf */}
                  <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-[90%] h-2 bg-black/30 blur-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );

  const renderOldStats = () => {
    if (!activeBook) return null;
    const s = getBookStats(activeBook.title);
    
    return (
      <div className="flex-1 flex flex-col h-full bg-brand-bg overflow-hidden">
        <header className="h-16 bg-white shrink-0">
          <div className="h-full max-w-7xl mx-auto flex items-center justify-between px-8">
            <div className="flex items-center gap-4">
              <button 
                onClick={() => { setScreen('reader'); startSession(); }}
                className="p-1 px-3 bg-brand-bg hover:bg-brand-card text-brand-text-heading rounded-full text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 transition-all border border-brand-border"
              >
                <ChevronLeft size={14} /> Back
              </button>
              <div className="flex items-center gap-3">
                {activeBook.coverUrl && (
                  <div className="w-8 h-10 rounded border border-brand-border overflow-hidden shrink-0 shadow-sm">
                    <img src={activeBook.coverUrl} alt="" className="w-full h-full object-cover" />
                  </div>
                )}
                <h2 className="text-lg font-bold text-brand-text-heading tracking-tight">Analytics Dashboard</h2>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => exportStats('json')} className="px-3 py-1 bg-white border border-brand-border rounded-full text-[10px] font-bold text-brand-text-heading/40 hover:border-brand-primary hover:text-brand-primary transition-colors uppercase tracking-widest">JSON</button>
              <button onClick={() => exportStats('txt')} className="bg-brand-primary text-brand-text-heading px-4 py-1.5 rounded-full text-[10px] font-bold shadow-lg shadow-brand-primary/20 hover:opacity-90 uppercase tracking-widest transition-all">Report</button>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
          <div className="max-w-7xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
              <div className="bg-brand-card p-6 rounded-[24px] border border-brand-border shadow-sm">
                <span className="text-slate-500 text-[10px] font-bold uppercase tracking-widest">Total Throughput</span>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-brand-text-heading">{formatTime(s.totalTime)}</span>
                  <span className="text-[10px] text-green-600 font-bold uppercase tracking-tighter">Active Sync</span>
                </div>
                <div className="mt-4 h-1.5 w-full bg-brand-bg rounded-full overflow-hidden">
                  <div className="h-full bg-brand-primary w-[100%] shadow-[0_0_8px_rgba(230,90,90,0.4)]"></div>
                </div>
              </div>
              <div className="bg-brand-card p-6 rounded-[24px] border border-brand-border shadow-sm">
                <span className="text-slate-500 text-[10px] font-bold uppercase tracking-widest">Page Indices</span>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-brand-text-heading">{s.pagesRead}</span>
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-tighter">Counted</span>
                </div>
                <div className="mt-4 flex gap-1 h-2 items-end">
                  {Array.from({length: 10}).map((_, i) => (
                    <div key={i} className="flex-1 bg-brand-primary/10 rounded-full" style={{ height: `${20 + Math.random() * 80}%` }}></div>
                  ))}
                </div>
              </div>
              <div className="bg-brand-card p-6 rounded-[24px] border border-brand-border shadow-sm">
                <span className="text-slate-500 text-[10px] font-bold uppercase tracking-widest">Session Logic</span>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-brand-text-heading">{s.sessions.length}</span>
                  <span className="text-[10px] text-brand-primary font-bold uppercase tracking-tighter">Logged</span>
                </div>
              </div>
              <div className="bg-brand-card p-6 rounded-[24px] border border-brand-border shadow-sm">
                <span className="text-slate-500 text-[10px] font-bold uppercase tracking-widest">Avg Pulse</span>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-brand-text-heading">
                    {s.sessions.length ? formatTime(s.totalTime / s.sessions.length) : '0m'}
                  </span>
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-tighter italic">ms/unit</span>
                </div>
              </div>
            </div>

            <div className="bg-brand-card rounded-[24px] border border-brand-border shadow-sm overflow-hidden flex flex-col">
              <div className="px-8 py-5 border-b border-brand-bg bg-brand-bg/10 flex justify-between items-center">
                <h3 className="font-bold text-brand-text-heading text-sm uppercase tracking-wide">Real-time Session Records</h3>
                <span className="text-[10px] font-bold text-brand-primary uppercase tracking-widest italic font-mono">Live Sync</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[10px] text-brand-text-heading/30 uppercase tracking-widest font-bold">
                      <th className="px-8 py-4 border-b border-brand-bg">Timestamp</th>
                      <th className="px-8 py-4 border-b border-brand-bg">Session ID</th>
                      <th className="px-8 py-4 border-b border-brand-bg text-right">Integrity Period</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm text-brand-text-heading/70 divide-y divide-brand-bg">
                    {s.sessions.length === 0 ? (
                      <tr><td colSpan={3} className="px-8 py-12 text-center text-slate-400 italic font-medium">No transactions found in pipeline.</td></tr>
                    ) : (
                      s.sessions.slice().reverse().map((sess, i) => {
                        const dt = new Date(sess.date);
                        return (
                          <tr key={i} className="hover:bg-brand-bg/20 transition-colors">
                            <td className="px-8 py-4 font-bold text-[11px] text-brand-text-heading/40">
                              {dt.toLocaleDateString()} {dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </td>
                            <td className="px-8 py-4 font-bold text-brand-text-heading text-xs">SES-{dt.getTime().toString().slice(-6)}</td>
                            <td className="px-8 py-4 text-right">
                              <span className="px-3 py-1 bg-brand-primary/10 text-brand-primary rounded-full text-[10px] font-bold">
                                {formatTime(sess.duration)}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderReader = () => {
    if (!activeBook) return null;

    return (
      <div className="flex flex-col h-screen bg-brand-bg md:p-8 overflow-hidden font-sans relative" style={{ overscrollBehavior: 'none' }}>
        {/* Floating Settings Button */}
        <button 
          onClick={() => setShowSettings(prev => !prev)}
          className="absolute top-6 right-6 w-10 h-10 bg-brand-accent border-2 border-brand-text-heading rounded-[12px] flex items-center justify-center text-brand-text-heading shadow-[4px_4px_0px_rgba(0,0,0,0.1)] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none transition-all z-[80]"
        >
          <span className="text-lg font-serif font-bold italic">T</span>
        </button>

        {/* Content Container */}
        <div className="flex-1 bg-white border-2 border-brand-border rounded-[32px] shadow-2xl overflow-hidden relative flex flex-col">
          <div ref={pageRef} className="flex-1 overflow-y-auto px-8 sm:px-16 py-16 custom-scrollbar" id="reader-content">
            <header className="mb-12 border-b-2 border-brand-border pb-8">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.3em] block mb-4">Fragment Sector {currentCh + 1}</span>
              <h1 className="text-4xl font-serif font-bold text-brand-text-heading leading-tight">{getChapterTitle(activeBook.chapters[currentCh])}</h1>
            </header>
            
            <div 
              className="prose prose-slate max-w-none prose-headings:font-serif prose-headings:text-brand-text-heading prose-p:text-brand-text-heading/80 prose-p:leading-relaxed"
              style={{ fontSize: `${fontSize}px`, textAlign: alignment as any }}
              dangerouslySetInnerHTML={{ __html: chapterContent || 'Fragment data corrupted.' }}
            />

            <div className="mt-20 flex justify-between items-center py-12 border-t border-brand-border">
              <button 
                onClick={prevChapter}
                disabled={currentCh === 0}
                className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-brand-text-heading/40 hover:text-brand-primary disabled:opacity-0 transition-colors"
              >
                <ChevronLeft size={16} /> Previous Sequence
              </button>
              <button 
                onClick={nextChapter}
                disabled={currentCh === activeBook.chapters.length - 1}
                className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-brand-text-heading/40 hover:text-brand-primary disabled:opacity-0 transition-colors"
              >
                Next Sequence <ChevronRight size={16} />
              </button>
            </div>
          </div>

          {/* New Bottom Control Bar */}
          <footer className="bg-brand-primary border-t-2 border-brand-text-heading px-4 sm:px-8 py-3 text-brand-text-heading shrink-0">
             <div className="flex flex-wrap items-center justify-between gap-4">
               <div className="flex items-center gap-2 sm:gap-4 shrink-0">
                 <button 
                   onClick={() => { endSession(); setScreen('library'); }}
                   className="p-2 hover:bg-black/5 rounded-full transition-colors"
                 >
                   <ArrowLeft size={20} className="sm:w-6 sm:h-6" />
                 </button>
                 <div className="flex flex-col">
                   <span className="text-[8px] sm:text-[9px] font-bold uppercase tracking-widest opacity-60">Currently Reading</span>
                   <span className="text-[10px] sm:text-xs font-bold truncate max-w-[100px] sm:max-w-[150px]">{activeBook.title}</span>
                 </div>
               </div>

               <div className="flex items-center gap-4 sm:gap-8">
                  <button onClick={prevChapter} className="p-1 sm:p-2 hover:bg-black/5 rounded-full transition-colors"><SkipBack size={18} sm:size={20} fill="currentColor" /></button>
                  <button onClick={nextChapter} className="p-1 sm:p-2 hover:bg-black/5 rounded-full transition-colors"><SkipForward size={18} sm:size={20} fill="currentColor" /></button>
               </div>

               <div className="flex items-center gap-1 sm:gap-2">
                  <button 
                    onClick={toggleBookmark}
                    className={`p-1.5 sm:p-3 rounded-full transition-colors ${currentBookBookmarks.includes(currentCh) ? 'text-white' : 'hover:bg-black/5'}`}
                    title="Bookmark Index"
                  >
                    <Bookmark size={18} sm:size={20} fill={currentBookBookmarks.includes(currentCh) ? "currentColor" : "none"} />
                  </button>
                  <button 
                    onClick={() => setShowBookmarks(true)}
                    className="p-1.5 sm:p-3 hover:bg-black/5 rounded-full transition-colors"
                    title="Saved Map"
                  >
                    <FileText size={18} sm:size={20} />
                  </button>
                  <button 
                    onClick={() => setShowAnnotations(true)}
                    className="p-1.5 sm:p-3 hover:bg-black/5 rounded-full transition-colors"
                    title="Session Logs"
                  >
                    <Edit2 size={18} sm:size={20} />
                  </button>
                  <button 
                    onClick={() => setScreen('stats')}
                    className="p-1.5 sm:p-3 hover:bg-black/5 rounded-full transition-colors"
                    title="Analytics"
                  >
                    <BarChart2 size={18} sm:size={20} className="rotate-90" />
                  </button>
                  <button 
                    onClick={() => setShowTOC(true)}
                    className="p-1.5 sm:p-3 hover:bg-black/5 rounded-full transition-colors"
                    title="Index Map"
                  >
                    <Menu size={18} sm:size={20} />
                  </button>
                  <div className="hidden sm:block h-10 w-[2px] bg-brand-text-heading/10 mx-2"></div>
                  <div className="flex flex-col items-end">
                     <span className="text-[8px] sm:text-[10px] font-bold uppercase tracking-widest opacity-60">{Math.round(((currentCh + 1) / activeBook.chapters.length) * 100)}%</span>
                     <div className="w-12 sm:w-24 h-1 bg-brand-text-heading/10 rounded-full mt-1 overflow-hidden">
                        <div className="h-full bg-brand-text-heading" style={{ width: `${((currentCh + 1) / activeBook.chapters.length) * 100}%` }}></div>
                     </div>
                  </div>
               </div>
             </div>
          </footer>
        </div>

        <AnimatePresence>
          {showTOC && (
            <motion.div 
              initial={{ x: '100%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '100%', opacity: 0 }}
              className="absolute inset-y-0 right-0 w-full sm:w-80 bg-brand-card shadow-2xl z-[90] border-l-2 border-brand-text-heading flex flex-col"
            >
              <div className="p-8 border-b-2 border-brand-border flex justify-between items-center bg-[#EEE4B1]/20">
                <h3 className="font-serif font-bold text-brand-text-heading text-lg">INDEX MAP</h3>
                <button onClick={() => setShowTOC(false)} className="p-2 hover:bg-black/5 rounded-full"><X size={20} /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-6 space-y-2 custom-scrollbar">
                {activeBook.chapters.map((ch, i) => (
                  <button 
                    key={i}
                    onClick={() => { setCurrentCh(i); setShowTOC(false); trackPageRead(); }}
                    className={`w-full text-left px-5 py-4 rounded-[16px] text-xs font-bold uppercase tracking-widest transition-all ${currentCh === i ? 'bg-brand-primary text-brand-text-heading shadow-lg shadow-brand-primary/20' : 'text-brand-text-heading/40 hover:bg-brand-bg hover:text-brand-text-heading'}`}
                  >
                    {getChapterTitle(ch)}
                  </button>
                ))}
              </div>
            </motion.div>
          )}

          {showSettings && (
            <motion.div 
              initial={{ x: '100%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '100%', opacity: 0 }}
              className="absolute inset-y-0 right-0 w-full sm:w-80 bg-brand-card shadow-2xl z-[90] border-l-2 border-brand-text-heading flex flex-col"
            >
              <div className="p-8 border-b-2 border-brand-border flex justify-between items-center bg-[#EEE4B1]/20">
                <h3 className="font-serif font-bold text-brand-text-heading text-lg">CONFIG</h3>
                <button onClick={() => setShowSettings(false)} className="p-2 hover:bg-black/5 rounded-full"><X size={20} /></button>
              </div>
              <div className="p-8 space-y-10">
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.3em] block mb-4">Text Scaling</label>
                  <div className="flex items-center gap-4 bg-brand-bg/50 p-2 rounded-full border-2 border-brand-border">
                    <button onClick={() => setFontSize(f => Math.max(12, f - 2))} className="w-12 h-12 rounded-full bg-white flex items-center justify-center font-bold shadow-sm">-</button>
                    <span className="flex-1 text-center font-bold text-brand-text-heading">{fontSize}px</span>
                    <button onClick={() => setFontSize(f => Math.min(48, f + 2))} className="w-12 h-12 rounded-full bg-white flex items-center justify-center font-bold shadow-sm">+</button>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.3em] block mb-4">Alignment</label>
                  <div className="grid grid-cols-4 gap-2">
                    {['left', 'center', 'right', 'justify'].map(a => (
                      <button 
                        key={a}
                        onClick={() => setAlignment(a as any)}
                        className={`p-4 rounded-[16px] flex items-center justify-center transition-all border-2 ${alignment === a ? 'bg-brand-primary text-brand-text-heading border-brand-text-heading' : 'bg-white text-slate-300 border-transparent hover:border-brand-border'}`}
                      >
                        {a === 'left' && <AlignLeft size={18} />}
                        {a === 'center' && <AlignCenter size={18} />}
                        {a === 'right' && <AlignRight size={18} />}
                        {a === 'justify' && <AlignJustify size={18} />}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {showBookmarks && (
            <motion.div 
              initial={{ x: '100%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '100%', opacity: 0 }}
              className="absolute inset-y-0 right-0 w-full sm:w-80 bg-brand-card shadow-2xl z-[90] border-l-2 border-brand-text-heading flex flex-col"
            >
              <div className="p-8 border-b-2 border-brand-border flex justify-between items-center bg-[#EEE4B1]/20">
                <h3 className="font-serif font-bold text-brand-text-heading text-lg">SAVED MAP</h3>
                <button onClick={() => setShowBookmarks(false)} className="p-2 hover:bg-black/5 rounded-full"><X size={20} /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar">
                {currentBookBookmarks.length === 0 ? (
                  <div className="text-center py-20">
                    <Bookmark size={48} className="mx-auto mb-4 text-brand-text-heading/10" />
                    <p className="text-[10px] font-bold text-brand-text-heading/30 uppercase tracking-widest">No flags detected.</p>
                  </div>
                ) : (
                  currentBookBookmarks.map((ch, i) => (
                    <div key={`${ch}-${i}`} className="flex items-center gap-2 group">
                      <button 
                        onClick={() => { setCurrentCh(ch); setShowBookmarks(false); }}
                        className="flex-1 text-left px-5 py-4 bg-brand-bg/30 border border-brand-border rounded-[16px] text-[10px] font-bold uppercase tracking-widest hover:border-brand-primary transition-all"
                      >
                        {getChapterTitle(activeBook.chapters[ch])}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          )}

          {showAnnotations && (
            <motion.div 
              initial={{ x: '100%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '100%', opacity: 0 }}
              className="absolute inset-y-0 right-0 w-full sm:w-96 bg-brand-card shadow-2xl z-[90] border-l-2 border-brand-text-heading flex flex-col"
            >
              <div className="p-8 border-b-2 border-brand-border flex justify-between items-center bg-[#EEE4B1]/20">
                <h3 className="font-serif font-bold text-brand-text-heading text-lg">FRAGMENT LOGS</h3>
                <button onClick={() => setShowAnnotations(false)} className="p-2 hover:bg-black/5 rounded-full"><X size={20} /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar">
                <div className="space-y-4">
                  <textarea 
                    value={annotationText}
                    onChange={(e) => setAnnotationText(e.target.value)}
                    placeholder="Commit new entry..."
                    className="w-full h-40 bg-white border-2 border-brand-border rounded-[24px] p-6 text-sm text-brand-text-heading font-medium focus:border-brand-primary outline-none transition-all resize-none"
                  />
                  <button 
                    onClick={() => saveAnnotation(annotationText)}
                    disabled={!annotationText.trim()}
                    className="w-full py-4 bg-brand-primary text-brand-text-heading font-bold text-[10px] uppercase tracking-[0.2em] rounded-[24px] hover:opacity-90 disabled:opacity-30 transition-all shadow-lg shadow-brand-primary/20"
                  >
                    Commit Entry
                  </button>
                </div>
                
                <div className="space-y-4 pt-8 border-t border-brand-border">
                  <h4 className="text-[10px] font-bold text-brand-text-heading/20 uppercase tracking-[0.2em]">Historical Logs</h4>
                  {currentChapterAnnotations.length === 0 ? (
                    <p className="text-center text-brand-text-heading/20 font-bold text-[9px] py-12 uppercase tracking-[0.1em]">No records found.</p>
                  ) : (
                    currentChapterAnnotations.slice().reverse().map((note, i) => (
                      <div key={`${note.date}-${i}`} className="bg-brand-bg/20 border border-brand-border p-5 rounded-[24px] relative group hover:border-brand-primary/30 transition-all">
                        <button 
                          onClick={() => deleteAnnotation(currentChapterAnnotations.length - 1 - i)}
                          className="absolute top-4 right-4 text-brand-text-heading/10 hover:text-brand-primary opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <Trash2 size={12} />
                        </button>
                        <div className="flex items-center gap-3 mb-2">
                           <div className="w-1 h-3 bg-brand-primary rounded-full"></div>
                           <p className="text-[9px] font-bold text-brand-text-heading/30 uppercase tracking-widest">{new Date(note.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</p>
                        </div>
                        <p className="text-xs text-brand-text-heading/80 leading-relaxed whitespace-pre-wrap">{note.text}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  const renderStats = () => {
    if (!activeBook) return null;
    const s = getBookStats(activeBook.title);
    
    return (
      <div className="flex-1 overflow-y-auto p-4 sm:p-8 custom-scrollbar">
        <header className="mb-8 sm:mb-12 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2 lg:hidden">
              <button 
                onClick={() => setScreen(activeBook ? 'reader' : 'library')}
                className="p-2 bg-brand-primary text-brand-text-heading rounded-full shadow-lg"
              >
                <ArrowLeft size={16} />
              </button>
              <span className="text-[10px] font-bold text-brand-text-heading uppercase tracking-widest">Back</span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-serif font-bold text-brand-text-heading tracking-tight mb-2 uppercase">Core Analytics</h2>
            <p className="text-xs font-bold text-slate-500 uppercase tracking-[0.3em] opacity-40">Session Integrity Logs</p>
          </div>
          <div className="flex gap-2">
            <button 
              onClick={() => { setScreen('reader'); startSession(); }}
              className="lg:flex hidden items-center gap-2 px-4 py-2 bg-brand-primary text-brand-text-heading rounded-full text-xs font-bold uppercase tracking-widest shadow-lg hover:opacity-90 transition-all"
            >
              Resume Reading
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className="bg-brand-card p-6 rounded-[24px] border border-brand-border">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total Time</span>
            <div className="text-2xl font-bold text-brand-text-heading mt-2 font-mono">{formatTime(s.totalTime)}</div>
          </div>
          <div className="bg-brand-card p-6 rounded-[24px] border border-brand-border">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Chapters Read</span>
            <div className="text-2xl font-bold text-brand-text-heading mt-2 font-mono">{s.pagesRead}</div>
          </div>
        </div>
        
        <div className="bg-brand-card rounded-[24px] border border-brand-border overflow-hidden">
          <div className="p-6 border-b border-brand-border bg-brand-bg/10 flex justify-between items-center">
            <h3 className="font-bold text-brand-text-heading text-sm uppercase">Session History</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-slate-400 uppercase tracking-widest font-bold">
                  <th className="p-6">Timestamp</th>
                  <th className="p-6 text-right">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-border">
                {s.sessions.slice().reverse().map((sess, i) => (
                  <tr key={i} className="hover:bg-brand-bg/20">
                    <td className="p-6 text-brand-text-heading/60 font-medium">{new Date(sess.date).toLocaleString()}</td>
                    <td className="p-6 text-right font-bold text-brand-primary">{formatTime(sess.duration)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-brand-bg selection:bg-brand-primary/20 relative">
      {quotaExceeded && renderQuotaNotice()}
      {authLoading ? (
        <div className="flex items-center justify-center h-screen">
          <div className="w-12 h-12 border-4 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : (
        <>
          {screen === 'home' && renderHome()}
          {screen === 'calendar' && renderCalendar()}
          {screen === 'library' && renderLibrary()}
          {screen === 'upload' && renderUpload()}
          {screen === 'reader' && renderReader()}
          {screen === 'stats' && renderLayout(renderStats())}
        </>
      )}
    </div>
  );
}
