/**
 * Roots & Wings Indy — script.js
 * Vanilla JavaScript for navigation, scroll animations, and member portal auth.
 */

(function () {
  'use strict';

  // ──────────────────────────────────────────────
  // 1. Mobile Navigation Toggle
  // ──────────────────────────────────────────────
  document.querySelectorAll('.nav-toggle').forEach(function (toggle) {
    toggle.addEventListener('click', function () {
      var expanded = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', String(!expanded));
      this.classList.toggle('open');

      // Find the sibling nav-links within the same navbar
      var navLinks = this.closest('.navbar').querySelector('.nav-links');
      if (navLinks) {
        navLinks.classList.toggle('open');
      }
    });
  });

  // Close mobile menu when a link is clicked
  document.querySelectorAll('.nav-links a').forEach(function (link) {
    link.addEventListener('click', function () {
      var navLinks = this.closest('.nav-links');
      var toggle = this.closest('.navbar').querySelector('.nav-toggle');
      if (navLinks && navLinks.classList.contains('open')) {
        navLinks.classList.remove('open');
        if (toggle) {
          toggle.classList.remove('open');
          toggle.setAttribute('aria-expanded', 'false');
        }
      }
    });
  });

  // ──────────────────────────────────────────────
  // 2. Navbar scroll effect
  // ──────────────────────────────────────────────
  var navbar = document.querySelector('.navbar');
  if (navbar && !navbar.classList.contains('scrolled')) {
    var onScroll = function () {
      if (window.scrollY > 40) {
        navbar.classList.add('scrolled');
      } else {
        navbar.classList.remove('scrolled');
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ──────────────────────────────────────────────
  // 3. Scroll-triggered fade-in animations
  // ──────────────────────────────────────────────
  var fadeEls = document.querySelectorAll('.fade-in');

  if (fadeEls.length > 0 && 'IntersectionObserver' in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );

    fadeEls.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    // Fallback: show everything immediately
    fadeEls.forEach(function (el) {
      el.classList.add('visible');
    });
  }

  // ──────────────────────────────────────────────
  // 4. Active nav link highlighting (public site)
  // ──────────────────────────────────────────────
  var sections = document.querySelectorAll('section[id]');
  var navLinksForHighlight = document.querySelectorAll('.navbar .nav-links a[href^="#"]');

  if (sections.length > 0 && navLinksForHighlight.length > 0) {
    var highlightNav = function () {
      var scrollPos = window.scrollY + 120;
      sections.forEach(function (section) {
        var top = section.offsetTop;
        var height = section.offsetHeight;
        var id = section.getAttribute('id');

        if (scrollPos >= top && scrollPos < top + height) {
          navLinksForHighlight.forEach(function (link) {
            link.classList.remove('active');
            if (link.getAttribute('href') === '#' + id) {
              link.classList.add('active');
            }
          });
        }
      });
    };
    window.addEventListener('scroll', highlightNav, { passive: true });
  }

  // ──────────────────────────────────────────────
  // 5. Member Portal Authentication
  // ──────────────────────────────────────────────
  //
  // IMPORTANT: This is a client-side password check for demo/development
  // purposes ONLY. It provides NO real security. For production, replace
  // with Google OAuth (e.g., Firebase Auth with Google sign-in) to
  // authenticate against the co-op's Google Workspace domain.
  //

  var loginForm = document.getElementById('loginForm');
  var loginSection = document.getElementById('loginSection');
  var dashboard = document.getElementById('dashboard');
  var loginError = document.getElementById('loginError');
  var passwordInput = document.getElementById('password');
  var logoutBtn = document.getElementById('logoutBtn');

  var SESSION_KEY = 'rw_member_auth';

  // ── Live Data Loading from Google Sheets ──
  var liveDataLoaded = false;
  var liveDataReady = false; // true once data has been applied

  var CACHE_KEY = 'rw_sheets_cache';
  var CACHE_PHOTOS_KEY = 'rw_photos_cache';

  function applySheetsData(data) {
    if (!data || data.error) return false;

        // ── Map board roles from volunteer committee chairs to families ──
        var BOARD_EMAIL_MAP = {
          'President': 'president', 'Vice President': 'vp',
          'Treasurer': 'treasurer', 'Secretary': 'secretary',
          'Membership Director': 'membership',
          'Sustaining Director': 'sustaining',
          'Communications Director': 'communications'
        };
        // Normalize abbreviated titles to full titles
        var BOARD_TITLE_MAP = {
          'Membership Dir.': 'Membership Director',
          'Sustaining Dir.': 'Sustaining Director',
          'Communications Dir.': 'Communications Director'
        };
        var boardByLastName = {}; // familyName -> { role, email }
        if (data.volunteerCommittees) {
          data.volunteerCommittees.forEach(function(c) {
            if (c.chair && c.chair.person && c.chair.title) {
              var parts = c.chair.person.trim().split(/\s+/);
              var lastName = parts[parts.length - 1];
              var fullTitle = BOARD_TITLE_MAP[c.chair.title] || c.chair.title;
              var emailPrefix = BOARD_EMAIL_MAP[fullTitle] || fullTitle.toLowerCase().replace(/[^a-z]/g, '');
              boardByLastName[lastName.toLowerCase()] = {
                role: fullTitle,
                email: emailPrefix + '@rootsandwingsindy.com'
              };
            }
          });
        }

        // ── Families ──
        if (data.families && data.families.length > 0) {
          // Assign board roles to matching families
          data.families.forEach(function(fam) {
            var board = boardByLastName[fam.name.toLowerCase()];
            if (board) {
              fam.boardRole = board.role;
              fam.boardEmail = board.email;
            }
          });
          FAMILIES = data.families;
          // Rebuild allPeople array used by directory (match original structure)
          allPeople = [];
          FAMILIES.forEach(function (fam) {
            var parentNames = (fam.parents || '').split(/\s*&\s*/);
            var pp = fam.parentPronouns || {};
            var diffNameKids = (fam.kids || []).filter(function(k) { return k.lastName && k.lastName !== fam.name; });
            parentNames.forEach(function (pName) {
              if (!pName.trim()) return;
              allPeople.push({
                name: pName.trim(),
                type: 'parent',
                family: fam.name,
                email: fam.email || '',
                phone: fam.phone || '',
                group: null,
                age: null,
                pronouns: pp[pName.trim()] || '',
                allergies: '',
                schedule: 'all-day',
                parentNames: fam.parents,
                diffNameKids: diffNameKids,
                kidNames: (fam.kids || []).map(function(k) { return k.name + ' ' + (k.lastName || fam.name); }),
                boardRole: fam.boardRole || null,
                boardEmail: fam.boardEmail || null
              });
            });
            (fam.kids || []).forEach(function (kid) {
              allPeople.push({
                name: kid.name,
                lastName: kid.lastName || fam.name,
                type: 'kid',
                family: fam.name,
                email: fam.email || '',
                phone: fam.phone || '',
                group: kid.group || '',
                age: kid.age || 0,
                pronouns: kid.pronouns || '',
                allergies: kid.allergies || '',
                schedule: kid.schedule || 'all-day',
                parentNames: fam.parents
              });
            });
          });
          allPeople.sort(function(a, b) { return a.name.localeCompare(b.name); });
        }

        // ── AM Classes ──
        if (data.amClasses) {
          // Map API keys to existing AM_CLASSES structure
          for (var group in data.amClasses) {
            AM_CLASSES[group] = data.amClasses[group];
          }
        }

        // ── AM Support Roles ──
        if (data.amSupportRoles) {
          for (var s in data.amSupportRoles) {
            AM_SUPPORT_ROLES[s] = data.amSupportRoles[s];
          }
        }

        // ── PM Electives ──
        if (data.pmElectives) {
          for (var s in data.pmElectives) {
            PM_ELECTIVES[s] = data.pmElectives[s];
          }
        }

        // ── PM Support Roles ──
        if (data.pmSupportRoles) {
          for (var s in data.pmSupportRoles) {
            PM_SUPPORT_ROLES[s] = data.pmSupportRoles[s];
          }
        }

        // ── Cleaning Crew ──
        if (data.cleaningCrew) {
          CLEANING_CREW.liaison = data.cleaningCrew.liaison;
          CLEANING_CREW.sessions = data.cleaningCrew.sessions;
        }

        // ── Volunteer Committees ──
        if (data.volunteerCommittees) {
          VOLUNTEER_COMMITTEES = data.volunteerCommittees;
        }

        // ── Special Events ──
        if (data.specialEvents) {
          SPECIAL_EVENTS = data.specialEvents;
        }

        // ── Class Ideas ──
        if (data.classIdeas) {
          CLASS_IDEAS = data.classIdeas;
        }

    liveDataReady = true;

    // Re-render if dashboard is already visible
    if (dashboard && dashboard.classList.contains('visible')) {
      if (typeof renderCoordinationTabs === 'function') renderCoordinationTabs();
      if (typeof renderDirectory === 'function') renderDirectory();
      if (typeof renderMyFamily === 'function') renderMyFamily();
    }
    return true;
  }

  function loadLiveData() {
    if (liveDataLoaded) return;
    liveDataLoaded = true;

    // Apply cached data immediately for instant load
    try {
      var cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        var cachedData = JSON.parse(cached);
        applySheetsData(cachedData);
      }
    } catch (e) { /* ignore cache errors */ }

    // Fetch fresh data in the background
    var googleCred = sessionStorage.getItem('rw_google_credential');
    if (!googleCred) return;

    fetch('/api/sheets', { headers: { 'Authorization': 'Bearer ' + googleCred } })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          console.warn('Sheets API error, using static/cached data:', data.message);
          return;
        }
        // Cache the fresh response
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* quota */ }
        // Apply fresh data (re-renders everything)
        applySheetsData(data);
      })
      .catch(function (err) {
        console.warn('Failed to load live data, using cached/static data:', err);
      });
  }

  // ── Profile Photos from Google Workspace ──
  var memberPhotos = {}; // email -> photo URL

  function loadPhotos() {
    // Apply cached photos immediately
    try {
      var cached = localStorage.getItem(CACHE_PHOTOS_KEY);
      if (cached) {
        memberPhotos = JSON.parse(cached);
        applyPhotos();
      }
    } catch (e) { /* ignore */ }

    // Fetch fresh photos in the background
    var googleCred = sessionStorage.getItem('rw_google_credential');
    if (!googleCred) return;

    fetch('/api/photos', { headers: { 'Authorization': 'Bearer ' + googleCred } })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.photos) {
          memberPhotos = data.photos;
          try { localStorage.setItem(CACHE_PHOTOS_KEY, JSON.stringify(data.photos)); } catch (e) { /* quota */ }
          applyPhotos();
        }
      })
      .catch(function(err) {
        console.warn('Failed to load profile photos:', err);
      });
  }

  // ── Calendar Events ──
  var CACHE_CALENDAR_KEY = 'rw_calendar_cache';
  var DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function renderCalendar(events) {
    var el = document.getElementById('calendarEvents');
    if (!el || !events) return;

    if (events.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:var(--color-text-light);padding:40px 0;">No upcoming events.</div>';
      return;
    }

    var html = '';
    var currentMonth = '';
    events.forEach(function(ev) {
      var start = new Date(ev.start);
      var end = new Date(ev.end);
      var monthLabel = MONTHS[start.getMonth()] + ' ' + start.getFullYear();

      if (monthLabel !== currentMonth) {
        currentMonth = monthLabel;
        html += '<div class="cal-month-header">' + monthLabel + '</div>';
      }

      var timeStr = '';
      if (!ev.allDay) {
        timeStr = start.toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'}).toLowerCase()
          + ' – ' + end.toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'}).toLowerCase();
      } else {
        timeStr = 'All day';
      }

      html += '<div class="cal-event">';
      html += '<div class="cal-date"><span class="cal-day-num">' + start.getDate() + '</span><span class="cal-day-name">' + DAYS[start.getDay()] + '</span></div>';
      html += '<div class="cal-details"><strong class="cal-summary">' + ev.summary + '</strong><span class="cal-time">' + timeStr + '</span>';
      if (ev.location) html += '<span class="cal-location">' + ev.location + '</span>';
      html += '</div></div>';
    });

    el.innerHTML = html;
  }

  function loadCalendar() {
    // Apply cached calendar immediately
    try {
      var cached = localStorage.getItem(CACHE_CALENDAR_KEY);
      if (cached) renderCalendar(JSON.parse(cached));
    } catch (e) { /* ignore */ }

    var googleCred = sessionStorage.getItem('rw_google_credential');
    if (!googleCred) return;

    fetch('/api/calendar', { headers: { 'Authorization': 'Bearer ' + googleCred } })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.events) {
          try { localStorage.setItem(CACHE_CALENDAR_KEY, JSON.stringify(data.events)); } catch (e) { /* quota */ }
          renderCalendar(data.events);
        }
      })
      .catch(function(err) {
        console.warn('Failed to load calendar:', err);
      });
  }

  function getPhotoUrl(personName, email, familyName) {
    if (!email && !familyName && !personName) return null;
    // Try matching by firstname + last initial first (e.g. "erinb" for "Erin Bogan")
    // This prioritizes personal accounts over role accounts (e.g. president@)
    if (personName && familyName) {
      var first = personName.trim().split(' ')[0].toLowerCase();
      var lastInitial = familyName.charAt(0).toLowerCase();
      var guess = first + lastInitial + '@rootsandwingsindy.com';
      if (memberPhotos[guess]) return memberPhotos[guess];
    }
    // Try direct email match
    if (email) {
      var url = memberPhotos[email] || memberPhotos[email.toLowerCase()];
      if (url) return url;
    }
    // Try matching by family last name
    if (familyName) {
      var lowerName = familyName.toLowerCase();
      for (var wsEmail in memberPhotos) {
        var localPart = wsEmail.split('@')[0].toLowerCase();
        if (localPart === lowerName || localPart.indexOf(lowerName) !== -1) {
          return memberPhotos[wsEmail];
        }
      }
    }
    return null;
  }

  function photoHtml(name, personName, email, familyName, extraStyle) {
    var url = getPhotoUrl(personName || name, email, familyName);
    var style = extraStyle || '';
    if (url) {
      // Increase resolution from 96px to 256px
      url = url.replace(/=s\d+-c/, '=s256-c');
      return '<img src="' + url + '" alt="' + name + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;' + style + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'\'">' +
        '<span style="display:none">' + name.charAt(0) + '</span>';
    }
    return '<span>' + name.charAt(0) + '</span>';
  }

  function applyPhotos() {
    // Find all yb-cards and update photos by matching family email
    if (!allPeople || allPeople.length === 0) return;
    var cards = document.querySelectorAll('.yb-card');
    cards.forEach(function(card) {
      var idx = parseInt(card.getAttribute('data-idx'));
      var person = allPeople[idx];
      if (!person) return;
      var photoDiv = card.querySelector('.yb-photo');
      if (!photoDiv) return;
      if (person.type === 'kid') return; // Skip kids — they share parent's Workspace photo
      var url = getPhotoUrl(person.name, person.email, person.family);
      if (url && !photoDiv.querySelector('img')) {
        var hiRes = url.replace(/=s\d+-c/, '=s256-c');
        photoDiv.innerHTML = '<img src="' + hiRes + '" alt="' + person.name + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'\'"><span style="display:none">' + person.name.charAt(0) + '</span>';
      }
    });

    // Update board cards with Workspace photos
    document.querySelectorAll('.portal-board-card[data-board]').forEach(function(card) {
      var fullName = card.getAttribute('data-board');
      var familyName = card.getAttribute('data-board-family');
      var boardEmail = card.getAttribute('data-board-email');
      var url = getPhotoUrl(fullName, boardEmail, familyName);
      if (!url) return;
      var hiRes = url.replace(/=s\d+-c/, '=s256-c');
      // Replace existing photo or initials avatar
      var existingImg = card.querySelector('.portal-board-photo');
      var existingAvatar = card.querySelector('.board-avatar');
      if (existingImg) {
        existingImg.src = hiRes;
      } else if (existingAvatar) {
        var img = document.createElement('img');
        img.src = hiRes;
        img.alt = fullName;
        img.className = 'portal-board-photo';
        img.onerror = function() { this.style.display = 'none'; existingAvatar.style.display = ''; };
        existingAvatar.style.display = 'none';
        card.insertBefore(img, existingAvatar);
      }
    });
  }

  // Live data is loaded after authentication (see showDashboard)

  function showDashboard() {
    if (loginSection) loginSection.style.display = 'none';
    if (dashboard) dashboard.classList.add('visible');
    // Load live data, profile photos, and calendar now that user is authenticated
    loadLiveData();
    loadPhotos();
    loadCalendar();
    // Render with whatever data is available (live if preloaded, static otherwise)
    setTimeout(function () { if (typeof renderMyFamily === 'function') renderMyFamily(); }, 0);
    // Re-trigger fade-in observer for dashboard elements
    var dashFades = dashboard ? dashboard.querySelectorAll('.fade-in') : [];
    if (dashFades.length > 0 && 'IntersectionObserver' in window) {
      var dashObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add('visible');
              dashObserver.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
      );
      dashFades.forEach(function (el) {
        dashObserver.observe(el);
      });
    } else {
      dashFades.forEach(function (el) {
        el.classList.add('visible');
      });
    }
  }

  function showLogin() {
    if (loginSection) loginSection.style.display = '';
    if (dashboard) dashboard.classList.remove('visible');
    sessionStorage.removeItem(SESSION_KEY);
  }

  // Check for existing session
  if (loginSection && dashboard) {
    if (sessionStorage.getItem(SESSION_KEY) === 'true') {
      showDashboard();
    }

    // Logout
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        // Clear cached data on logout
        try {
          localStorage.removeItem(CACHE_KEY);
          localStorage.removeItem(CACHE_PHOTOS_KEY);
        } catch (e) { /* ignore */ }
        showLogin();
        window.scrollTo(0, 0);
      });
    }
  }

  // ──────────────────────────────────────────────
  // 6. Smooth scroll for anchor links (fallback)
  // ──────────────────────────────────────────────
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      var targetId = this.getAttribute('href');
      if (targetId === '#' || targetId.length < 2) return;

      var target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        var navHeight = document.querySelector('.members-nav') ? document.querySelector('.members-nav').offsetHeight : 60;
        var targetPos = target.getBoundingClientRect().top + window.pageYOffset - navHeight - 16;
        window.scrollTo({ top: targetPos, behavior: 'smooth' });
      }
    });
  });

  // ──────────────────────────────────────────────
  // Tour Modal — close on Escape key
  // ──────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var modal = document.getElementById('tour-modal');
      if (modal && modal.classList.contains('active')) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
      }
      // Also close style switcher
      var panel = document.querySelector('.style-switcher-panel');
      if (panel) panel.classList.remove('open');
    }
  });

  // ──────────────────────────────────────────────
  // 7. Portal — Tabs
  // ──────────────────────────────────────────────
  document.querySelectorAll('.portal-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var tabId = this.getAttribute('data-tab');
      this.closest('.portal-tabs').querySelectorAll('.portal-tab').forEach(function (t) {
        t.classList.remove('active');
      });
      this.closest('.portal-tabs').querySelectorAll('.portal-tab-panel').forEach(function (p) {
        p.classList.remove('active');
      });
      this.classList.add('active');
      var panel = document.getElementById('tab-' + tabId);
      if (panel) panel.classList.add('active');
    });
  });

  // ──────────────────────────────────────────────
  // 7b. Yearbook Directory
  // ──────────────────────────────────────────────

  // Color palette for initials circles (deterministic by first letter)
  var FACE_COLORS = [
    ['#2D6A3F','#8DB43E'], ['#5BACC8','#2D6A3F'], ['#D4712A','#E8A628'],
    ['#6B4E71','#B68CB5'], ['#5B8A8D','#7A9E7E'], ['#C4847A','#D4915E'],
    ['#3D6B6E','#5BACC8'], ['#B07348','#E8A628'], ['#4E3754','#6B4E71']
  ];

  function faceColor(name) {
    var i = (name.charCodeAt(0) + (name.length > 1 ? name.charCodeAt(1) : 0)) % FACE_COLORS.length;
    return 'linear-gradient(135deg,' + FACE_COLORS[i][0] + ',' + FACE_COLORS[i][1] + ')';
  }


  // ── Session metadata ──
  var SESSION_DATES = {
    1: { name: 'Fall Session 1', start: '2025-09-03', end: '2025-10-01' },
    2: { name: 'Fall Session 2', start: '2025-10-15', end: '2025-11-12' },
    3: { name: 'Winter Session 3', start: '2026-01-14', end: '2026-02-11' },
    4: { name: 'Spring Session 4', start: '2026-03-04', end: '2026-04-01' },
    5: { name: 'Spring Session 5', start: '2026-04-15', end: '2026-05-13' }
  };

  // Auto-detect current session: move to next session once the end date passes
  var currentSession = 5; // default to last session
  var today = new Date().toISOString().slice(0, 10);
  for (var s = 1; s <= 5; s++) {
    if (SESSION_DATES[s] && today <= SESSION_DATES[s].end) {
      currentSession = s;
      break;
    }
  }

  // ── Morning classes (by group, per session) ──
  var AM_CLASSES = {
    'Greenhouse': {
      ages: '0–2',
      note: 'No programming',
      liaison: 'Ashley Brooks',
      sessions: {
        1: { topic: 'Free Play', room: 'Patience', teacher: 'Rachel Adams', assistants: ['Angela Carter'] },
        2: { topic: 'Free Play', room: 'Patience', teacher: 'Angela Carter', assistants: ['Rachel Adams'] },
        3: { topic: 'Free Play', room: 'Patience', teacher: 'Lisa Chen', assistants: ['Brittany Coleman'] },
        4: { topic: 'Free Play', room: 'Patience', teacher: 'Rachel Adams', assistants: ['Lisa Chen'] },
        5: { topic: 'Free Play', room: 'Patience', teacher: 'Angela Carter', assistants: ['Ashley Brooks'] }
      }
    },
    'Saplings': {
      ages: '3–5',
      liaison: 'Laura Campbell',
      sessions: {
        1: { topic: 'Seasons & Weather', room: 'Faithfulness', teacher: 'Jen Baker', assistants: ['Amy Foster'] },
        2: { topic: 'Animals & Habitats', room: 'Faithfulness', teacher: 'Amy Foster', assistants: ['Jen Baker'] },
        3: { topic: 'Colors & Shapes', room: 'Faithfulness', teacher: 'Kevin Ellis', assistants: ['Amanda Fisher'] },
        4: { topic: 'Nature Art', room: 'Trust', teacher: 'Amanda Fisher', assistants: ['Laura Campbell'] },
        5: { topic: 'Garden Explorers', room: 'Trust', teacher: 'Jen Baker', assistants: ['Kevin Ellis'] }
      }
    },
    'Sassafras': {
      ages: '5–6',
      liaison: 'Danielle Graves',
      sessions: {
        1: { topic: 'Five Senses', room: 'Trust', teacher: 'Rachel Adams', assistants: ['Danielle Graves'] },
        2: { topic: 'Becoming Nocturnal', room: 'Trust', teacher: 'Nicole Keller', assistants: ['Tiffany Morris'] },
        3: { topic: 'Map Makers', room: 'Trust', teacher: 'Danielle Graves', assistants: ['Rachel Adams'] },
        4: { topic: 'Story Science', room: 'Trust', teacher: 'Tiffany Morris', assistants: ['Nicole Keller'] },
        5: { topic: 'Bug Detectives', room: 'Trust', teacher: 'Shannon Quinn', assistants: ['Danielle Graves'] }
      }
    },
    'Oaks': {
      ages: '7–8',
      liaison: 'Maria Garcia',
      sessions: {
        1: { topic: 'The Science of Cooking', room: 'Patience', teacher: 'Sarah Anderson', assistants: ['Brittany Coleman'] },
        2: { topic: 'STEAM', room: 'Patience', teacher: 'Maria Garcia', assistants: ['Kevin Ellis'] },
        3: { topic: 'Simple Machines', room: 'Patience', teacher: 'Gabriela Martinez', assistants: ['Erica Patterson'] },
        4: { topic: 'Ancient Egypt', room: 'Patience', teacher: 'Soo-Yun Kim', assistants: ['Maria Garcia'] },
        5: { topic: 'Weather Watchers', room: 'Patience', teacher: 'Kristen Henderson', assistants: ['Sarah Anderson'] }
      }
    },
    'Maples': {
      ages: '8–9',
      liaison: 'Kim Johnson',
      sessions: {
        1: { topic: 'Inventors, Explorers & Eco Warriors', room: 'Faithfulness', teacher: 'DeShawn Barnes', assistants: ['Lisa Chen'] },
        2: { topic: 'Adventures with Alice', room: 'Faithfulness', teacher: 'Kim Johnson', assistants: ['Latasha Jackson'] },
        3: { topic: 'Myth & Legend', room: 'Faithfulness', teacher: 'Latasha Jackson', assistants: ['Denise Mitchell'] },
        4: { topic: 'Robotics', room: 'Faithfulness', teacher: 'Denise Mitchell', assistants: ['Kim Johnson'] },
        5: { topic: 'Ocean Explorers', room: 'Faithfulness', teacher: 'Lisa Chen', assistants: ['DeShawn Barnes'] }
      }
    },
    'Birch': {
      ages: '9–10',
      liaison: 'Tamara Dixon',
      sessions: {
        1: { topic: 'The Human Body', room: 'MPR', teacher: 'Rachel Davis', assistants: ['Tamara Dixon'] },
        2: { topic: 'Maps & Treasures', room: 'MPR', teacher: 'Eric Collins', assistants: ['Linh Nguyen'] },
        3: { topic: 'Geology Rocks', room: 'MPR', teacher: 'Tamara Dixon', assistants: ['Cassandra Owens'] },
        4: { topic: 'Creative Writing', room: 'MPR', teacher: 'Cassandra Owens', assistants: ['Rachel Davis'] },
        5: { topic: 'Debate Club', room: 'MPR', teacher: 'Linh Nguyen', assistants: ['Eric Collins'] }
      }
    },
    'Willows': {
      ages: '10–11',
      liaison: 'Heather Lawson',
      sessions: {
        1: { topic: 'Art', room: 'Goodness', teacher: 'Courtney Bennett', assistants: ['Tonya Harris'] },
        2: { topic: "It's a Surprise!", room: 'Goodness', teacher: 'Heather Lawson', assistants: ['Megan Sullivan'] },
        3: { topic: 'Photography', room: 'Goodness', teacher: 'Tonya Harris', assistants: ['Heather Lawson'] },
        4: { topic: 'World Cultures', room: 'Goodness', teacher: 'Megan Sullivan', assistants: ['Courtney Bennett'] },
        5: { topic: 'Entrepreneurship', room: 'Goodness', teacher: 'Courtney Bennett', assistants: ['Linh Nguyen'] }
      }
    },
    'Cedars': {
      ages: '12–13',
      liaison: 'Amy Foster',
      sessions: {
        1: { topic: 'Australia', room: 'JYF', teacher: 'Marcus Brooks', assistants: ['Monica Crawford'] },
        2: { topic: 'Woodworking', room: 'JYF', teacher: 'Elena Ramirez', assistants: ['Amy Foster'] },
        3: { topic: 'Film Production', room: 'JYF', teacher: 'Amy Foster', assistants: ['Marcus Brooks'] },
        4: { topic: 'Chemistry', room: 'JYF', teacher: 'Monica Crawford', assistants: ['Elena Ramirez'] },
        5: { topic: 'Mock Trial', room: 'JYF', teacher: 'Marcus Brooks', assistants: ['Monica Crawford'] }
      }
    },
    'Pigeons': {
      ages: '14+',
      liaison: 'Kendra Robinson',
      sessions: {
        1: { topic: 'LARPing', room: 'MYF', teacher: 'Keisha Washington', assistants: ['Kendra Robinson'] },
        2: { topic: 'International Sweets & Eats', room: 'MYF', teacher: 'Kendra Robinson', assistants: ['Heather Lawson'] },
        3: { topic: 'Debate & Rhetoric', room: 'MYF', teacher: 'Heather Lawson', assistants: ['Keisha Washington'] },
        4: { topic: 'Film Studies', room: 'MYF', teacher: 'Kim Johnson', assistants: ['Cassandra Owens'] },
        5: { topic: 'Senior Projects', room: 'MYF', teacher: 'Cassandra Owens', assistants: ['Kim Johnson'] }
      }
    }
  };

  // ── Afternoon electives (per session) ──
  var PM_ELECTIVES = {
    4: [
      // Hour 1
      {name:'Cooking', hour:1, ageRange:'3-6', description:'We are going to be cracking some eggs, whisking cream and getting down in the kitchen with our littlest cooks learning how to make Dutch babies, fruit galettes and more!', room:'Kitchen', leader:'Maria Garcia', assistants:['Angela Carter'], maxCapacity:10, students:['Jaylen Barnes','Owen Campbell','Willa Bogan','Trinity Brooks','Leo Davis','Piper Graves','Eli Keller']},
      {name:'Puppet Fun', hour:1, ageRange:'3-7', description:'In this class we will read and learn about different types of puppets and a bit about the history of puppets and puppeteers. We will make our own puppets in a few different styles and even put on a short puppet show!', room:'Trust', leader:'Monica Crawford', assistants:['Laura Campbell'], maxCapacity:10, students:['Chloe Davis','Diego Martinez','Hana Kim','Nolan Patterson','Clara Fisher','Wyatt Henderson','Imani Washington','Theo Billingsley']},
      {name:'Pirates', hour:1, ageRange:'7-11', description:'Building a cardboard boat, making pirate names and decor, learning pirate songs, learn knots \u2014 set sail on a swashbuckling adventure!', room:'Faithfulness', leader:'Marcus Brooks', assistants:['Eric Collins'], maxCapacity:12, students:['Emma Anderson','Noah Baker','Aiden Coleman','Sadie Ellis','Rosie Bellner','Declan Sullivan','Xavier Harris','Camila Martinez']},
      {name:"What's Beneath Our Feet?", hour:1, ageRange:'7-11', description:"Worm investigations! Model of the Earth's layers! Core samples to find the best place to build a house! What does trash tell us about a civilization? How do archaeologists study trash?", room:'MPR', leader:'Rachel Davis', assistants:['Erica Patterson'], maxCapacity:10, students:['Hazel Campbell','Sofia Garcia','Jude Kim','Minh Nguyen','Nia Barnes','Sophia Chen','Teddy Bogan']},
      {name:'Collage', hour:1, ageRange:'7-11', description:'Snip it, rip it, stick it! Let\'s turn art chaos into AWESOME.', room:'Patience', leader:'Priya Ellis', assistants:['Denise Mitchell'], maxCapacity:10, students:['Ruby Henderson','Jasper Crawford','Valentina Ramirez','Amelia Johnson','Beckett Graves','Wren Mitchell','Poppy Patterson']},
      {name:'Mythbusters', hour:1, ageRange:'10+', description:'Can you really make a battery from a lemon? Does toast always land butter-side down? Questions, experiments... Chaos?', room:'Goodness', leader:'Eric Collins', assistants:['Tamara Dixon'], maxCapacity:10, students:['Ezra Dixon','Violet Hughes','Malcolm Washington','Luna Keller','Harper Bennett','Naomi Harris','An Nguyen']},
      {name:'Board Games Club', hour:1, ageRange:'11+', description:'Bring in your favorite board games to play with friends or borrow some of ours!', room:'MYF', leader:'Chris Foster', assistants:[], maxCapacity:12, students:['Sawyer Lawson','Maeve Sullivan','Sam Bellner','Ava Baker','Lily Coleman','Mateo Garcia']},
      {name:'Improv', hour:1, ageRange:'12+', description:"Come work on your improv skills! Whether you're an experienced improviser or brand new to the form, you're welcome to join the fun. Yes, let's!", room:'JYF', leader:'Courtney Bennett', assistants:['Kendra Robinson'], maxCapacity:12, students:['Lucia Martinez','Margot Quinn','Silas Taylor','Jordan Brooks','Ivy Dixon','Mason Foster','Cruz Ramirez']},
      {name:'Upcycled Sewing Studio', hour:'both', ageRange:'10+', description:'This is an open-ended sewing studio. Haberdashery, sewing machine safety, and basic sewing by hand will be provided. Please bring old or retired clothes, fabric, bits and bobs to add to your upcycled creation!', room:'Kitchen Annex', leader:'Kim Johnson', assistants:['Heather Lawson'], maxCapacity:12, students:['Jada Robinson','Stella Owens','Gavin Shewan','Iris Billingsley','Caleb Smith','June Bogan']},
      // Hour 2
      {name:'Indoor Outdoor Games', hour:2, ageRange:'3-10', description:'We will play games and hang out. If the weather is pleasant we will move outside!', room:'Faithfulness', leader:'Ben Hughes', assistants:['Ashley Brooks'], maxCapacity:12, students:['Jaylen Barnes','Dante Ramirez','Ethan Foster','Claire Shewan','Blake Mitchell','August Palmer','Leo Davis','Theo Billingsley']},
      {name:'Musical Art', hour:2, ageRange:'3-12', description:'Do you like pop, rock, jazz, broadway hits, classical, techno? Each week we will have a different style of music playing as we create our own art. Let the music inspire you! A variety of art supplies and mediums will be available and music requests will be taken!', room:'Patience', leader:'Heather Lawson', assistants:['Megan Sullivan'], maxCapacity:12, students:['Bea Newlin','Archer Hughes','Rowan Ellis','Asher Taylor','Nora Raymont','Maya Carter','Aria Morris']},
      {name:'Bingo', hour:2, ageRange:'5+', description:"All ages welcome as long as you know your letters! Let's play bingo and win prizes!", room:'Trust', leader:'Shannon Quinn', assistants:['Nicole Keller'], maxCapacity:14, students:['Willa Bogan','Trinity Brooks','Kai Collins','Olivia Baker','Piper Graves','Eli Keller','Imani Washington','Emma Anderson','Poppy Patterson']},
      {name:'Pet Science', hour:2, ageRange:'7-11', description:"Want to know if you, your cat, or your dog has the cleanest mouth? What about if Crazy Cat Ladies are a real thing? Have you heard of Pavlov's dogs and pet training? Would it work on your siblings?", room:'Goodness', leader:'Amanda Fisher', assistants:['Gabriela Martinez'], maxCapacity:10, students:['Noah Baker','Aiden Coleman','Hazel Campbell','Jude Kim','Nia Barnes','Sophia Chen','Teddy Bogan']},
      {name:'Percy Jackson Adventure Club', hour:2, ageRange:'9+', description:"Calling all demigods! Are you ready to live your own hero's journey? Each week, we'll step into the world of Percy Jackson for epic role-playing quests, combat training with safe swords and archery, and themed snacks. Expect plenty of blue treats, high-stakes games, and a chance to hang out with fellow fans!", room:'MPR', leader:'Kendra Robinson', assistants:['Keisha Washington'], maxCapacity:12, students:['Amelia Johnson','Beckett Graves','Caleb Adams','Liam Anderson','Roman Collins','Ezra Dixon','Violet Hughes','Will Raymont']},
      {name:'Beginner Ukulele', hour:2, ageRange:'10+', description:'In this class students will learn 2-3 simple chords that can be used to play dozens of songs! They will learn how to properly hold and care for a ukulele. Bring your singing voice because we will be singing along!', room:'MYF', leader:'Kevin Ellis', assistants:[], maxCapacity:10, students:['Luna Keller','Malcolm Washington','Harper Bennett','Mila Davis','An Nguyen','Maeve Sullivan']},
      {name:'D&D Club', hour:2, ageRange:'12+', description:'This is a student-led D&D club. Embark on a tabletop roleplaying adventure with your fellow adventurers!', room:'JYF', leader:'Matt Johnson', assistants:[], maxCapacity:8, students:['Ava Baker','Mateo Garcia','Silas Taylor','Jordan Brooks','Ivy Dixon','Mason Foster','Henry Johnson']}
    ]
  };

  // ── AM Support Roles (per session) ──
  var AM_SUPPORT_ROLES = {
    4: {
      floaters: { '10-11': ['Brittany Coleman', 'Latasha Jackson'], '11-12': ['DeShawn Barnes', 'Latasha Jackson'] },
      prepPeriod: { '10-11': ['Linh Nguyen', 'Jessica Palmer'], '11-12': ['Linh Nguyen'] },
      boardDuties: { '10-11': ['Molly Bellner'], '11-12': ['Anna Billingsley'] }
    }
  };

  var PM_SUPPORT_ROLES = {
    4: { floaters: ['Brittany Coleman', 'Tanya Barnes'], boardDuties: ['Molly Bellner', 'LeAnn Newlin', 'Tiffany Smith'], supplyCloset: ['Monica Crawford'] }
  };

  // ── Cleaning crew assignments (structured by area) ──
  var CLEANING_CREW = {
    liaison: 'Parn Sudmee',
    sessions: {
      4: {
        mainFloor: {
          'Classrooms & MPR': ['Anderson', 'Baker'],
          'Kitchen': ['Chen', 'Davis'],
          'Kitchen Annex & FH': ['Foster', 'Garcia'],
          'Hallways': ['Hughes'],
          'Bathrooms': ['Johnson']
        },
        upstairs: {
          'Classrooms': ['Keller'],
          'Bathrooms': ['Martinez'],
          'Halls & Stairs': ['Mitchell']
        },
        outside: {
          'Garage & Grounds': ['Morris']
        },
        floater: ['Nguyen']
      }
    }
  };

  // ── Volunteer committees (year-long) ──
  var VOLUNTEER_COMMITTEES = [
    {
      name: 'Facility Committee',
      chair: { title: 'President', person: 'Molly Bellner' },
      roles: [
        { title: 'Opener & Morning Set-Up', person: 'Kristen Henderson' },
        { title: 'Closer/Lost & Found', person: 'Erica Patterson' },
        { title: 'Safety Coordinator', person: 'Colleen Raymont' },
        { title: 'Cleaning Crew Liaison', person: 'Parn Sudmee' }
      ]
    },
    {
      name: 'Programming Committee',
      chair: { title: 'Vice President', person: 'Colleen Raymont' },
      roles: [
        { title: 'Morning Class Liaisons', person: 'See class groups' },
        { title: 'Afternoon Class Liaison', person: 'Tamara Dixon' }
      ]
    },
    {
      name: 'Finance Committee',
      chair: { title: 'Treasurer', person: 'Jessica Shewan' },
      roles: [
        { title: 'Fundraising Coordinator', person: 'Elena Ramirez' },
        { title: 'Field Trip Coordinators', person: 'LeAnn Newlin' },
        { title: 'Supply Coordinator', person: 'Monica Crawford' }
      ]
    },
    {
      name: 'Support Committee',
      chair: { title: 'Sustaining Director', person: 'Anna Billingsley' },
      roles: [
        { title: 'Summer Social Events', person: 'Megan Sullivan' },
        { title: 'Parent Social Events', person: 'Molly Bellner' },
        { title: 'Special Events Liaison', person: 'Courtney Bennett' },
        { title: 'Gratitude/Encouragement', person: 'Priya Ellis' }
      ]
    },
    {
      name: 'Administrative Committee',
      chair: { title: 'Secretary', person: 'LeAnn Newlin' },
      roles: [
        { title: 'Archives', person: '' },
        { title: 'Admin/Organization', person: '' }
      ]
    },
    {
      name: 'Membership Committee',
      chair: { title: 'Membership Director', person: 'Tiffany Smith' },
      roles: [
        { title: 'Welcome Coordinator', person: 'Laura Campbell' },
        { title: 'Public Communications', person: '' }
      ]
    },
    {
      name: 'Communications Committee',
      chair: { title: 'Communications Director', person: 'Erin Bogan' },
      roles: [
        { title: 'Yearbook Coordinator', person: 'Tonya Harris' }
      ]
    }
  ];

  // ── Special events ──
  var SPECIAL_EVENTS = [
    {name:'Ice Cream Social', date:'August 27, 2025', coordinator:'', planningSupport:['','',''], maxSupport:3, status:'Complete'},
    {name:'Fall Dance', date:'October 17, 2025', coordinator:'Carrie', planningSupport:['','','','',''], maxSupport:5, status:'Complete'},
    {name:"Maker's Market", date:'December 3, 2025', coordinator:'Bethany', planningSupport:['','','',''], maxSupport:4, status:'Complete'},
    {name:'PJ Party', date:'December 10, 2025', coordinator:'Lyndsey', planningSupport:['','',''], maxSupport:3, status:'Complete'},
    {name:'Service Project', date:'December 10, 2025', coordinator:'Sarah', planningSupport:['','',''], maxSupport:3, status:'Complete'},
    {name:'Passion Fair', date:'February 11, 2026', coordinator:'Lindsey', planningSupport:['','',''], maxSupport:3, status:'Complete'},
    {name:'Camping Trip', date:'March 30 \u2013 April 1, 2026', coordinator:'Amber', planningSupport:['','',''], maxSupport:3, status:'Planning'},
    {name:'Talent Show', date:'May 20, 2026', coordinator:'Shelly', planningSupport:['','',''], maxSupport:3, status:'Planning'},
    {name:'Field Day', date:'May 20, 2026', coordinator:'', planningSupport:['',''], maxSupport:2, status:'Needs Volunteers'}
  ];

  // ── Class Ideas Board ──
  var CLASS_IDEAS = {
    'Early Years (3-7)': ['Nature Art','Crafts','Truth or Dare','Reptiles','Making Stuffed Animals','Hot Air Balloons','Baking/Cake Decorating','Playdough','Painting/Art/Food Art','Building (Nature/Blocks/Cardboard)','Trees','Flowers','Cats','Fish','Dinosaurs','Weddings','Weaving','Dance','Caterpillars','Buses','Camping','Hairstyling','Castles','Gems','Costumes','Snow','Sculpting','Make-up/Facepaint','Wikkistix/Pipecleaner Crafts','Origami','Dreams','Foxes'],
    'Young Years (8-11)': ['DND Lite','Mystery Class','Nature Art','Crafts','Truth or Dare','Taste Testing','Percy Jackson','Jewelry','Animals of the World','Martial Arts/Ninja Obstacle Course','Making Miniatures & Scenes','Sewing','Fashion Design','Minute to Win It Games','Ancient History','Space/Astronomy/Shooting Stars','Beeswax Crafts','Canine Predators','Foods Around the World','Science','Gymnastics','Bunnies','Horrible Histories','Writing Books','Greeking Out','Doughnut Making','Crystals','Exercise Challenges','Pokemon','Digital Art','Fossils','Gardening','Remote Control Car Obstacle Course','Hide & Seek','Tag/Freeze Tag/Freeze Dance','Geology','Star Wars','Pixel Art','Theater','Yoga','Ballroom Dance','Emojis','Flag Football/Capture the Flag','Ocean Life','Food Chains','Drawing'],
    'Middle/Teen (11+)': ['Dessert/Baking','Australia Themed Class','Puppet Shows','Sports of All Sorts','Dungeons and Dragons','Advanced Art','Embroidery','Outdoor Games (Sardines, Hide & Seek)','Primitive Shelter Building','Among Us In Real Life','Doodle Class','Nerf Battle Class','History of Nintendo','Archery','Basketball','Junk Food Making','Parkour','Costume/Prop Making','Dragons','Machine Sewing','Painting','Nature Art','Resin','Mixology/Drinks Around the World','Legos','Animal Facts & Trivia','Craft Club','Fiber Arts','Fort Building','Charades & Snacks','Clay Critters','Physical Challenges','Photography','Coding','Mythology','Movie Making','Board Game Design','Roller Blades','Making Miniatures','Face Painting','Archery','Movie Club','Obstacle Course','Kickball','Capture the Flag','Cut Throat Kitchen/Chopped','Sewing','Cubing/Speed Cubing']
  };

  // Family data — will be replaced by Google Sheet CSV when connected
  // Kid fields: name, age, group, pronouns, allergies (empty string = none)
  var FAMILIES = [
    {name:'Adams',parents:'Rachel & Tom',parentPronouns:{'Rachel':'she/her'},email:'adams@email.com',phone:'(317) 555-0101',kids:[
      {name:'Zoe',age:6,group:'Sassafras',pronouns:'',allergies:''},
      {name:'Caleb',age:10,group:'Birch',pronouns:'',allergies:'peanut, tree nut'}]},
    {name:'Anderson',parents:'Sarah & Mike',email:'anderson@email.com',phone:'(317) 555-0102',kids:[
      {name:'Emma',age:7,group:'Oaks',pronouns:'',allergies:''},
      {name:'Liam',age:10,group:'Birch',pronouns:'',allergies:''}]},
    {name:'Baker',parents:'Jen',email:'baker@email.com',phone:'(317) 555-0103',kids:[
      {name:'Olivia',age:5,group:'Saplings',pronouns:'',allergies:'dairy'},
      {name:'Noah',age:8,group:'Oaks',pronouns:'',allergies:'dairy'},
      {name:'Ava',age:12,group:'Cedars',pronouns:'',allergies:''}]},
    {name:'Barnes',parents:'DeShawn & Tanya',email:'barnes@email.com',phone:'(317) 555-0104',kids:[
      {name:'Jaylen',age:3,group:'Saplings',pronouns:'',allergies:''},
      {name:'Nia',age:9,group:'Maples',pronouns:'',allergies:''}]},
    {name:'Bennett',parents:'Courtney',email:'bennett@email.com',phone:'(317) 555-0105',kids:[
      {name:'Harper',age:11,group:'Willows',pronouns:'she/her',allergies:'bee sting (EpiPen in backpack)',lastName:'Reeves'}]},
    {name:'Brooks',parents:'Marcus & Ashley',email:'brooks@email.com',phone:'(317) 555-0106',kids:[
      {name:'Micah',age:1,group:'Greenhouse',pronouns:'',allergies:'egg'},
      {name:'Trinity',age:5,group:'Saplings',pronouns:'',allergies:''},
      {name:'Jordan',age:13,group:'Cedars',pronouns:'they/them',allergies:'',schedule:'morning'}]},
    {name:'Campbell',parents:'Laura',email:'campbell@email.com',phone:'(317) 555-0107',kids:[
      {name:'Owen',age:4,group:'Saplings',pronouns:'',allergies:''},
      {name:'Hazel',age:8,group:'Oaks',pronouns:'',allergies:''}]},
    {name:'Carter',parents:'Angela & Brian',email:'carter@email.com',phone:'(317) 555-0108',kids:[
      {name:'Maya',age:6,group:'Sassafras',pronouns:'',allergies:'gluten'},
      {name:'Elijah',age:9,group:'Maples',pronouns:'',allergies:''},
      {name:'Norah',age:14,group:'Pigeons',pronouns:'',allergies:'',schedule:'afternoon'}]},
    {name:'Chen',parents:'Lisa & David',email:'chen@email.com',phone:'(317) 555-0109',kids:[
      {name:'Sophia',age:9,group:'Maples',pronouns:'',allergies:''}]},
    {name:'Coleman',parents:'Brittany',email:'coleman@email.com',phone:'(317) 555-0110',kids:[
      {name:'Aiden',age:7,group:'Oaks',pronouns:'',allergies:'peanut'},
      {name:'Lily',age:12,group:'Cedars',pronouns:'',allergies:''}]},
    {name:'Collins',parents:'Eric & Vanessa',email:'collins@email.com',phone:'(317) 555-0111',kids:[
      {name:'Isla',age:2,group:'Greenhouse',pronouns:'',allergies:''},
      {name:'Kai',age:5,group:'Saplings',pronouns:'he/him',allergies:''},
      {name:'Roman',age:10,group:'Birch',pronouns:'',allergies:''},
      {name:'Sienna',age:14,group:'Pigeons',pronouns:'',allergies:'shellfish'}]},
    {name:'Crawford',parents:'Monica',email:'crawford@email.com',phone:'(317) 555-0112',kids:[
      {name:'Jasper',age:8,group:'Oaks',pronouns:'',allergies:''}]},
    {name:'Davis',parents:'Rachel & Nathan',email:'davis@email.com',phone:'(317) 555-0113',kids:[
      {name:'Chloe',age:3,group:'Saplings',pronouns:'',allergies:''},
      {name:'Leo',age:6,group:'Sassafras',pronouns:'',allergies:''},
      {name:'Mila',age:11,group:'Willows',pronouns:'',allergies:''}]},
    {name:'Dixon',parents:'Tamara',email:'dixon@email.com',phone:'(317) 555-0114',kids:[
      {name:'Ezra',age:10,group:'Birch',pronouns:'',allergies:''},
      {name:'Ivy',age:13,group:'Cedars',pronouns:'',allergies:''}]},
    {name:'Ellis',parents:'Kevin & Priya',parentPronouns:{'Kevin':'he/him','Priya':'she/her'},email:'ellis@email.com',phone:'(317) 555-0115',kids:[
      {name:'Rowan',age:4,group:'Saplings',pronouns:'they/them',allergies:''},
      {name:'Sadie',age:7,group:'Oaks',pronouns:'',allergies:''}]},
    {name:'Fisher',parents:'Amanda',email:'fisher@email.com',phone:'(317) 555-0116',kids:[
      {name:'Theo',age:1,group:'Greenhouse',pronouns:'',allergies:''},
      {name:'Clara',age:5,group:'Saplings',pronouns:'',allergies:'egg'}]},
    {name:'Foster',parents:'Amy & Chris',email:'foster@email.com',phone:'(317) 555-0117',kids:[
      {name:'Ethan',age:4,group:'Saplings',pronouns:'',allergies:''},
      {name:'Isabella',age:7,group:'Oaks',pronouns:'',allergies:''},
      {name:'Mason',age:13,group:'Cedars',pronouns:'',allergies:''}]},
    {name:'Garcia',parents:'Maria & Carlos',email:'garcia@email.com',phone:'(317) 555-0118',kids:[
      {name:'Sofia',age:8,group:'Oaks',pronouns:'',allergies:''},
      {name:'Mateo',age:12,group:'Cedars',pronouns:'',allergies:''}]},
    {name:'Graves',parents:'Danielle',email:'graves@email.com',phone:'(317) 555-0119',kids:[
      {name:'Piper',age:6,group:'Sassafras',pronouns:'',allergies:''},
      {name:'Beckett',age:9,group:'Maples',pronouns:'',allergies:'tree nut'}]},
    {name:'Harris',parents:'Tonya & James',email:'harris@email.com',phone:'(317) 555-0120',kids:[
      {name:'Aaliyah',age:2,group:'Greenhouse',pronouns:'',allergies:''},
      {name:'Xavier',age:7,group:'Oaks',pronouns:'',allergies:''},
      {name:'Naomi',age:11,group:'Willows',pronouns:'she/her',allergies:'dairy'}]},
    {name:'Henderson',parents:'Kristen',email:'henderson@email.com',phone:'(317) 555-0121',kids:[
      {name:'Wyatt',age:5,group:'Saplings',pronouns:'',allergies:''},
      {name:'Ruby',age:8,group:'Oaks',pronouns:'',allergies:''},
      {name:'Finn',age:14,group:'Pigeons',pronouns:'',allergies:'',schedule:'afternoon'}]},
    {name:'Hughes',parents:'Ben & Stephanie',email:'hughes@email.com',phone:'(317) 555-0122',kids:[
      {name:'Archer',age:3,group:'Saplings',pronouns:'',allergies:''},
      {name:'Violet',age:10,group:'Birch',pronouns:'',allergies:''}]},
    {name:'Jackson',parents:'Latasha',email:'jackson@email.com',phone:'(317) 555-0123',kids:[
      {name:'Miles',age:9,group:'Maples',pronouns:'',allergies:''},
      {name:'Sage',age:13,group:'Cedars',pronouns:'they/them',allergies:'',lastName:'Thornton',schedule:'morning'}]},
    {name:'Johnson',parents:'Kim & Matt',email:'johnson@email.com',phone:'(317) 555-0124',kids:[
      {name:'Amelia',age:9,group:'Maples',pronouns:'',allergies:''},
      {name:'Henry',age:14,group:'Pigeons',pronouns:'',allergies:'peanut'}]},
    {name:'Keller',parents:'Nicole & Greg',email:'keller@email.com',phone:'(317) 555-0125',kids:[
      {name:'Iris',age:1,group:'Greenhouse',pronouns:'',allergies:''},
      {name:'Eli',age:6,group:'Sassafras',pronouns:'',allergies:''},
      {name:'Luna',age:10,group:'Birch',pronouns:'',allergies:''}]},
    {name:'Kim',parents:'Soo-Yun & Daniel',email:'kim@email.com',phone:'(317) 555-0126',kids:[
      {name:'Hana',age:4,group:'Saplings',pronouns:'',allergies:''},
      {name:'Jude',age:8,group:'Oaks',pronouns:'',allergies:''}]},
    {name:'Lawson',parents:'Heather',email:'lawson@email.com',phone:'(317) 555-0127',kids:[
      {name:'Sawyer',age:11,group:'Willows',pronouns:'he/him',allergies:''},
      {name:'Daisy',age:14,group:'Pigeons',pronouns:'',allergies:''}]},
    {name:'Martinez',parents:'Gabriela & Jose',email:'martinez@email.com',phone:'(317) 555-0128',kids:[
      {name:'Diego',age:3,group:'Saplings',pronouns:'',allergies:''},
      {name:'Camila',age:7,group:'Oaks',pronouns:'',allergies:''},
      {name:'Lucia',age:12,group:'Cedars',pronouns:'',allergies:''}]},
    {name:'Mitchell',parents:'Denise',email:'mitchell@email.com',phone:'(317) 555-0129',kids:[
      {name:'Blake',age:5,group:'Saplings',pronouns:'',allergies:''},
      {name:'Wren',age:9,group:'Maples',pronouns:'',allergies:''}]},
    {name:'Morris',parents:'Tiffany & Andre',email:'morris@email.com',phone:'(317) 555-0130',kids:[
      {name:'Zion',age:2,group:'Greenhouse',pronouns:'',allergies:''},
      {name:'Aria',age:6,group:'Sassafras',pronouns:'',allergies:''}]},
    {name:'Nguyen',parents:'Linh & Tuan',email:'nguyen@email.com',phone:'(317) 555-0131',kids:[
      {name:'Minh',age:8,group:'Oaks',pronouns:'',allergies:''},
      {name:'An',age:11,group:'Willows',pronouns:'',allergies:''}]},
    {name:'Owens',parents:'Cassandra',email:'owens@email.com',phone:'(317) 555-0132',kids:[
      {name:'Felix',age:7,group:'Oaks',pronouns:'',allergies:''},
      {name:'Stella',age:10,group:'Birch',pronouns:'',allergies:'gluten'},
      {name:'Gus',age:14,group:'Pigeons',pronouns:'',allergies:''}]},
    {name:'Palmer',parents:'Jessica & Ryan',email:'palmer@email.com',phone:'(317) 555-0133',kids:[
      {name:'Olive',age:1,group:'Greenhouse',pronouns:'',allergies:''},
      {name:'August',age:5,group:'Saplings',pronouns:'',allergies:''},
      {name:'Scarlett',age:9,group:'Maples',pronouns:'',allergies:''}]},
    {name:'Patterson',parents:'Erica',email:'patterson@email.com',phone:'(317) 555-0134',kids:[
      {name:'Nolan',age:4,group:'Saplings',pronouns:'',allergies:''},
      {name:'Poppy',age:7,group:'Oaks',pronouns:'',allergies:''}]},
    {name:'Quinn',parents:'Shannon & Derek',email:'quinn@email.com',phone:'(317) 555-0135',kids:[
      {name:'Levi',age:6,group:'Sassafras',pronouns:'',allergies:''},
      {name:'Margot',age:12,group:'Cedars',pronouns:'',allergies:''}]},
    {name:'Ramirez',parents:'Elena',email:'ramirez@email.com',phone:'(317) 555-0136',kids:[
      {name:'Dante',age:3,group:'Saplings',pronouns:'',allergies:''},
      {name:'Valentina',age:8,group:'Oaks',pronouns:'',allergies:''},
      {name:'Cruz',age:13,group:'Cedars',pronouns:'',allergies:''}]},
    {name:'Robinson',parents:'Kendra & Marcus',email:'robinson@email.com',phone:'(317) 555-0137',kids:[
      {name:'Jada',age:10,group:'Birch',pronouns:'',allergies:''},
      {name:'Elias',age:14,group:'Pigeons',pronouns:'',allergies:''}]},
    {name:'Sullivan',parents:'Megan & Patrick',parentPronouns:{'Megan':'she/her'},email:'sullivan@email.com',phone:'(317) 555-0138',kids:[
      {name:'Fiona',age:2,group:'Greenhouse',pronouns:'',allergies:''},
      {name:'Declan',age:7,group:'Oaks',pronouns:'',allergies:''},
      {name:'Maeve',age:11,group:'Willows',pronouns:'',allergies:''}]},
    {name:'Taylor',parents:'Christine',email:'taylor@email.com',phone:'(317) 555-0139',kids:[
      {name:'Asher',age:5,group:'Saplings',pronouns:'',allergies:''},
      {name:'Juniper',age:9,group:'Maples',pronouns:'',allergies:''},
      {name:'Silas',age:12,group:'Cedars',pronouns:'',allergies:''}]},
    {name:'Washington',parents:'Keisha & Robert',email:'washington@email.com',phone:'(317) 555-0140',kids:[
      {name:'Imani',age:6,group:'Sassafras',pronouns:'',allergies:''},
      {name:'Malcolm',age:10,group:'Birch',pronouns:'',allergies:''},
      {name:'Zara',age:14,group:'Pigeons',pronouns:'',allergies:''}]},
    // Board member families (stub data)
    {name:'Bellner',parents:'Molly & Jake',email:'bellner@email.com',phone:'(317) 555-0141',boardRole:'President',boardEmail:'president@rootsandwingsindy.com',kids:[
      {name:'Rosie',age:7,group:'Oaks',pronouns:'',allergies:''},
      {name:'Sam',age:11,group:'Willows',pronouns:'',allergies:''}]},
    {name:'Raymont',parents:'Colleen & Travis',email:'raymont@email.com',phone:'(317) 555-0142',boardRole:'Vice President',boardEmail:'vp@rootsandwingsindy.com',kids:[
      {name:'Nora',age:5,group:'Saplings',pronouns:'',allergies:''},
      {name:'Will',age:9,group:'Maples',pronouns:'',allergies:'peanut'}]},
    {name:'Smith',parents:'Tiffany & Dan',email:'smith@email.com',phone:'(317) 555-0143',boardRole:'Membership Director',boardEmail:'membership@rootsandwingsindy.com',kids:[
      {name:'Lena',age:8,group:'Oaks',pronouns:'she/her',allergies:''},
      {name:'Caleb',age:13,group:'Cedars',pronouns:'',allergies:''}]},
    {name:'Shewan',parents:'Jessica & Patrick',email:'shewan@email.com',phone:'(317) 555-0144',boardRole:'Treasurer',boardEmail:'treasurer@rootsandwingsindy.com',kids:[
      {name:'Claire',age:4,group:'Saplings',pronouns:'',allergies:'dairy'},
      {name:'Gavin',age:10,group:'Birch',pronouns:'',allergies:''}]},
    {name:'Billingsley',parents:'Anna & Jeff',email:'billingsley@email.com',phone:'(317) 555-0145',boardRole:'Sustaining Director',boardEmail:'sustaining@rootsandwingsindy.com',kids:[
      {name:'Theo',age:6,group:'Sassafras',pronouns:'',allergies:''},
      {name:'Iris',age:12,group:'Cedars',pronouns:'she/her',allergies:''}]},
    {name:'Newlin',parents:'LeAnn & Doug',email:'newlin@email.com',phone:'(317) 555-0146',boardRole:'Secretary',boardEmail:'secretary@rootsandwingsindy.com',kids:[
      {name:'Bea',age:3,group:'Saplings',pronouns:'',allergies:''},
      {name:'Hugo',age:8,group:'Oaks',pronouns:'',allergies:'tree nut'}]},
    {name:'Bogan',parents:'Erin & Scott',email:'bogan@email.com',phone:'(317) 555-0147',boardRole:'Communications Director',boardEmail:'communications@rootsandwingsindy.com',kids:[
      {name:'Willa',age:5,group:'Saplings',pronouns:'',allergies:''},
      {name:'Teddy',age:9,group:'Maples',pronouns:'',allergies:''},
      {name:'June',age:14,group:'Pigeons',pronouns:'she/her',allergies:''}]}
  ];

  // Build flat list of all people (parents + kids) for the yearbook
  var allPeople = [];
  FAMILIES.forEach(function (fam) {
    var parentNames = fam.parents.split(' & ');
    var pp = fam.parentPronouns || {};
    // Collect kids with different last names for parent display
    var diffNameKids = fam.kids.filter(function(k) { return k.lastName && k.lastName !== fam.name; });
    parentNames.forEach(function (pName) {
      allPeople.push({
        name: pName.trim(),
        type: 'parent',
        family: fam.name,
        email: fam.email,
        phone: fam.phone,
        group: null,
        age: null,
        pronouns: pp[pName.trim()] || '',
        allergies: '',
        schedule: 'all-day',
        parentNames: fam.parents,
        diffNameKids: diffNameKids,
        kidNames: fam.kids.map(function(k) { return k.name + ' ' + (k.lastName || fam.name); }),
        boardRole: fam.boardRole || null,
        boardEmail: fam.boardEmail || null
      });
    });
    fam.kids.forEach(function (kid) {
      allPeople.push({
        name: kid.name,
        lastName: kid.lastName || fam.name, // defaults to family name
        type: 'kid',
        family: fam.name,
        email: fam.email,
        phone: fam.phone,
        group: kid.group,
        age: kid.age,
        pronouns: kid.pronouns || '',
        allergies: kid.allergies || '',
        schedule: kid.schedule || 'all-day',
        parentNames: fam.parents
      });
    });
  });

  // Sort everyone alphabetically by first name so board members aren't grouped separately
  allPeople.sort(function(a, b) {
    return a.name.localeCompare(b.name);
  });

  var directoryGrid = document.getElementById('directoryGrid');
  var directorySearch = document.getElementById('directorySearch');
  var directoryCount = document.getElementById('directoryCount');
  var personDetail = document.getElementById('personDetail');
  var personDetailCard = document.getElementById('personDetailCard');
  var activeFilter = 'parents';

  // Helper: find a person in allPeople by full name (first + family)
  function findPersonByFullName(fullName) {
    var parts = fullName.split(' ');
    var first = parts[0];
    var last = parts.slice(1).join(' ');
    for (var i = 0; i < allPeople.length; i++) {
      if (allPeople[i].name === first && allPeople[i].family === last) return {person: allPeople[i], idx: i};
    }
    return null;
  }

  // Helper: build a clickable staff member chip
  function staffChip(fullName, role) {
    var found = findPersonByFullName(fullName);
    var tag = found ? 'button' : 'span';
    var dataAttr = found ? ' data-staff-idx="' + found.idx + '"' : '';
    var pronouns = found && found.person.pronouns ? ' <em class="staff-pronouns">(' + found.person.pronouns + ')</em>' : '';
    return '<' + tag + ' class="staff-role"' + dataAttr + '>' +
      '<div class="staff-dot" style="background:' + faceColor(fullName) + '"><span>' + fullName.charAt(0) + '</span></div>' +
      '<div class="staff-label"><strong>' + fullName + pronouns + '</strong><small>' + role + '</small></div>' +
      '</' + tag + '>';
  }

  // Is this a class/group filter? Handle "Teens" alias for "Pigeons"
  function isGroupFilter(f) {
    if (f === 'all' || f === 'parents') return false;
    return AM_CLASSES[f] || (f === 'Teens' && AM_CLASSES['Pigeons']);
  }

  function renderDirectory() {
    if (!directoryGrid) return;
    var query = (directorySearch ? directorySearch.value : '').toLowerCase();
    var staff = AM_CLASSES[activeFilter];
    var isClassView = isGroupFilter(activeFilter) && !query;
    var html = '';
    var shown = 0;

    // ---- Class view (group filter, no search) — cards with extra info ----
    if (isClassView) {
      // Staff banner with room + age info
      var sess = staff.sessions[currentSession];
      html += '<div class="class-staff-banner">';
      html += '<div class="class-staff-header">';
      html += '<span class="class-staff-title">' + groupWithAge(activeFilter) + '</span>';
      html += '<span class="class-staff-meta">Room: ' + (sess ? sess.room : '') + ' &middot; Ages ' + staff.ages;
      if (staff.note) html += ' &middot; ' + staff.note;
      if (sess && sess.topic) html += '<br><em>' + sess.topic + '</em>';
      html += '</span>';
      html += '</div>';
      html += '<div class="class-staff-roles">';
      html += staffChip(staff.liaison, 'Liaison (year-long)');
      if (sess) {
        html += staffChip(sess.teacher, 'Leader (Session ' + currentSession + ')');
        sess.assistants.forEach(function (a) {
          html += staffChip(a, 'Assistant (Session ' + currentSession + ')');
        });
      }
      html += '</div></div>';

      // Face cards for kids in this group (excluding afternoon-only)
      allPeople.forEach(function (person, idx) {
        if (person.type !== 'kid' || person.group !== activeFilter) return;
        if (person.schedule === 'afternoon') return;

        var displayName = person.lastName && person.lastName !== person.family
          ? person.name + ' ' + person.lastName
          : person.name;
        var bgStyle = faceColor(person.name);
        var extras = '';
        if (person.pronouns) extras += '<div class="yb-pronouns">' + person.pronouns + '</div>';
        if (person.allergies) extras += '<div class="yb-allergy">' + person.allergies + '</div>';
        if (person.schedule === 'morning') extras += '<div class="yb-schedule">AM only</div>';

        html += '<button class="yb-card yb-card-class" data-idx="' + idx + '" aria-label="' + displayName + ' ' + person.family + '">' +
          '<div class="yb-photo" style="background:' + bgStyle + '"><span>' + person.name.charAt(0) + '</span></div>' +
          '<div class="yb-name">' + displayName + '</div>' +
          '<div class="yb-subtitle">' + (person.age ? 'Age ' + person.age : '') + '</div>' +
          '<div class="yb-family">' + person.family + ' Family</div>' +
          extras +
          '</button>';
        shown++;
      });

    } else {
      // ---- Face grid view (Everyone / Parents Only / search) ----
      allPeople.forEach(function (person, idx) {
        if (activeFilter === 'parents' && person.type !== 'parent') return;
        if (isGroupFilter(activeFilter)) {
          if (person.type === 'parent') return;
          if (person.group !== activeFilter) return;
        }

        if (query) {
          var searchText = (person.name + ' ' + (person.lastName || person.family) + ' ' + person.family + ' ' + (person.group || '') + ' ' + person.parentNames + ' ' + (person.kidNames ? person.kidNames.join(' ') : '')).toLowerCase();
          if (searchText.indexOf(query) === -1) return;
        }

        var displayName = person.type === 'kid' && person.lastName && person.lastName !== person.family
          ? person.name + ' ' + person.lastName
          : person.name;
        var subtitle = person.type === 'kid'
          ? (person.age ? 'Age ' + person.age + ' &middot; ' : '') + groupWithAge(person.group)
          : 'Parent';
        var bgStyle = faceColor(person.name);

        var pronounTag = person.pronouns ? '<div class="yb-pronouns">' + person.pronouns + '</div>' : '';

        // Show "Parent of X" when kids have different last names
        var parentOfTag = '';
        if (person.type === 'parent' && person.diffNameKids && person.diffNameKids.length > 0) {
          var dnk = person.diffNameKids;
          var label = dnk[0].name + ' ' + dnk[0].lastName;
          if (dnk.length === 2) label += ' & ' + dnk[1].name + ' ' + dnk[1].lastName;
          else if (dnk.length > 2) label += ' + ' + (dnk.length - 1) + ' more';
          parentOfTag = '<div class="yb-parent-of">Parent of ' + label + '</div>';
        }

        var boardEmojis = {
          'President': '\u{1F333}', 'Vice President': '\u{1F33F}',
          'Treasurer': '\u{1F9EE}', 'Secretary': '\u{270F}\uFE0F',
          'Membership Director': '\u{1F33B}',
          'Sustaining Director': '\u{1F49A}',
          'Communications Director': '\u{1F4AC}'
        };
        var boardTag = person.boardRole
          ? '<div class="yb-board-badge"><span class="yb-board-emoji">' + (boardEmojis[person.boardRole] || '\u{1F331}') + '</span> ' + person.boardRole + '</div>'
          : '';

        html += '<button class="yb-card' + (person.boardRole ? ' yb-card-board' : '') + '" data-idx="' + idx + '" aria-label="' + displayName + ' ' + person.family + '">' +
          '<div class="yb-photo" style="background:' + bgStyle + '"><span>' + person.name.charAt(0) + '</span></div>' +
          '<div class="yb-name">' + displayName + '</div>' +
          '<div class="yb-subtitle">' + subtitle + '</div>' +
          boardTag +
          pronounTag +
          '<div class="yb-family">' + person.family + ' Family</div>' +
          parentOfTag +
          '</button>';
        shown++;
      });
    }

    directoryGrid.innerHTML = html;
    if (directoryCount) {
      if (isClassView) {
        directoryCount.textContent = shown + ' students in ' + activeFilter;
      } else {
        directoryCount.textContent = shown + ' of ' + allPeople.length + ' people';
      }
    }

    // Click handlers — face cards
    directoryGrid.querySelectorAll('.yb-card').forEach(function (card) {
      card.addEventListener('click', function () {
        var idx = parseInt(this.getAttribute('data-idx'), 10);
        showPersonDetail(allPeople[idx]);
      });
    });

    // Click handlers — staff banner people
    directoryGrid.querySelectorAll('[data-staff-idx]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var idx = parseInt(this.getAttribute('data-staff-idx'), 10);
        showPersonDetail(allPeople[idx]);
      });
    });

    // Apply profile photos if loaded
    applyPhotos();
  }

  function showPersonDetail(person, boardInfo) {
    if (!personDetail || !personDetailCard) return;
    var fam = FAMILIES.filter(function(f){return f.name === person.family;})[0];
    if (!fam) return;

    var emailSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>';
    var phoneSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';

    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="detail-header">';
    var detailPhotoUrl = person.type !== 'kid' ? getPhotoUrl(person.name, person.email, person.family) : null;
    if (detailPhotoUrl) {
      var hiResDetail = detailPhotoUrl.replace(/=s\d+-c/, '=s256-c');
      html += '<div class="detail-photo" style="background:' + faceColor(person.name) + '"><img src="' + hiResDetail + '" alt="' + person.name + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'\'"><span style="display:none">' + person.name.charAt(0) + '</span></div>';
    } else {
      html += '<div class="detail-photo" style="background:' + faceColor(person.name) + '"><span>' + person.name.charAt(0) + '</span></div>';
    }
    html += '<div class="detail-info">';
    var detailLast = person.lastName || fam.name;
    html += '<h3>' + person.name + ' ' + detailLast + '</h3>';
    if (boardInfo) {
      html += '<p class="detail-board-role">' + boardInfo.role + '</p>';
    }
    if (person.type === 'kid') {
      html += '<p class="detail-group">' + (person.age ? 'Age ' + person.age + ' &middot; ' : '') + groupWithAge(person.group) + '</p>';
      if (person.pronouns) html += '<p class="detail-pronouns">' + person.pronouns + '</p>';
      if (person.schedule && person.schedule !== 'all-day') {
        html += '<p class="detail-schedule">' + (person.schedule === 'morning' ? 'Morning only' : 'Afternoon only') + '</p>';
      }
      if (person.allergies) html += '<p class="detail-allergy-info">Allergies: ' + person.allergies + '</p>';
      html += '<p class="detail-parents">Parents: ' + fam.parents + '</p>';
    } else {
      if (!boardInfo) html += '<p class="detail-group">Parent</p>';
      if (person.pronouns) html += '<p class="detail-pronouns">' + person.pronouns + '</p>';
      // Kids shown in family grid below
    }
    html += '</div></div>';

    html += '<div class="detail-contact">';
    if (boardInfo) {
      html += '<a href="mailto:' + boardInfo.email + '" class="detail-btn detail-btn-board">';
      html += emailSvg + ' ' + boardInfo.email + ' <small>(' + boardInfo.role + ')</small></a>';
    }
    html += '<a href="mailto:' + fam.email + '" class="detail-btn detail-btn-email">';
    html += emailSvg + ' ' + fam.email + (boardInfo ? ' <small>(personal)</small>' : '') + '</a>';
    html += '<a href="tel:' + fam.phone.replace(/[^+\d]/g, '') + '" class="detail-btn detail-btn-phone">';
    html += phoneSvg + ' ' + fam.phone + '</a>';
    html += '</div>';

    // Board responsibilities
    if (boardInfo && boardInfo.responsibilities) {
      html += '<div class="detail-responsibilities">';
      html += '<h4>' + boardInfo.responsibilities.committee + '</h4>';
      html += '<ul>';
      boardInfo.responsibilities.bullets.forEach(function (b) {
        html += '<li>' + b + '</li>';
      });
      html += '</ul></div>';
    }

    // Show other family members
    html += '<div class="detail-family">';
    html += '<h4>' + fam.name + ' Family</h4>';
    html += '<div class="detail-family-grid">';
    // Parents
    fam.parents.split(' & ').forEach(function(pName) {
      var pPhoto = getPhotoUrl(pName.trim(), fam.email, fam.name);
      html += '<div class="detail-member' + (pName.trim() === person.name ? ' detail-member-current' : '') + '">';
      if (pPhoto) {
        var pPhotoHi = pPhoto.replace(/=s\d+-c/, '=s128-c');
        html += '<div class="detail-member-dot" style="background:' + faceColor(pName.trim()) + '"><img src="' + pPhotoHi + '" alt="' + pName.trim() + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'\'"><span style="display:none">' + pName.trim().charAt(0) + '</span></div>';
      } else {
        html += '<div class="detail-member-dot" style="background:' + faceColor(pName.trim()) + '"><span>' + pName.trim().charAt(0) + '</span></div>';
      }
      html += '<span>' + pName.trim() + '</span><small>Parent</small></div>';
    });
    // Kids
    fam.kids.forEach(function(kid) {
      html += '<div class="detail-member' + (kid.name === person.name ? ' detail-member-current' : '') + '">';
      html += '<div class="detail-member-dot" style="background:' + faceColor(kid.name) + '"><span>' + kid.name.charAt(0) + '</span></div>';
      html += '<span>' + kid.name + '</span><small>' + groupWithAge(kid.group) + '</small></div>';
    });
    html += '</div></div>';

    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Close handlers
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) {
      if (e.target === personDetail) closeDetail();
    });
  }

  function closeDetail() {
    if (personDetail) {
      personDetail.style.display = 'none';
      document.body.style.overflow = '';
    }
  }

  // Responsibility detail popup
  function showDutyDetail(duty) {
    if (!duty.popup || !personDetail || !personDetailCard) return;
    var p = duty.popup;
    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail">';

    if (p.type === 'amClass') {
      var cls = AM_CLASSES[p.group];
      var sess = cls ? cls.sessions[p.session] : null;
      html += '<div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;">';
      html += '<h3 style="margin:0;">' + groupWithAge(p.group) + '</h3>';
      if (cls && cls.liaison) {
        html += '<span style="font-size:0.85rem;color:var(--color-text-light);">Liaison: <strong style="color:var(--color-text);">' + cls.liaison + '</strong></span>';
      }
      html += '</div>';
      html += '<div class="elective-meta">';
      html += '<span>10:00 &ndash; 12:00</span>';
      html += '<span>' + (sess ? sess.room : '') + '</span>';
      html += '</div>';
      if (sess && sess.topic) html += '<p class="elective-description" style="font-style:italic;">' + sess.topic + '</p>';
      html += '<div class="elective-staff-list">';
      if (sess && sess.teacher) {
        html += '<div class="elective-teacher">';
        html += '<div class="staff-dot" style="background:' + faceColor(sess.teacher) + ';width:36px;height:36px;"><span style="font-size:0.85rem;">' + sess.teacher.charAt(0) + '</span></div>';
        html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + sess.teacher + '</strong><small style="color:var(--color-text-light);">Leader</small></div>';
        html += '</div>';
      }
      if (sess && sess.assistants) {
        sess.assistants.forEach(function(a) {
          html += '<div class="elective-teacher">';
          html += '<div class="staff-dot" style="background:' + faceColor(a) + ';width:36px;height:36px;"><span style="font-size:0.85rem;">' + a.charAt(0) + '</span></div>';
          html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + a + '</strong><small style="color:var(--color-text-light);">Assistant</small></div>';
          html += '</div>';
        });
      }
      html += '</div>';
      // Show kids in this group
      var groupKids = allPeople.filter(function(person) { return person.type === 'kid' && person.group === p.group; });
      if (groupKids.length > 0) {
        html += '<h4 class="elective-roster-title">' + groupKids.length + ' Students</h4>';
        html += '<div class="elective-roster">';
        groupKids.forEach(function(kid) {
          html += '<div class="elective-student">';
          html += '<div class="elective-student-dot" style="background:' + faceColor(kid.name) + '"><span>' + kid.name.charAt(0) + '</span></div>';
          html += '<div><strong>' + kid.name + '</strong> <span class="elective-student-last">' + (kid.lastName || kid.family) + '</span></div>';
          html += '</div>';
        });
        html += '</div>';
      }
    }

    else if (p.type === 'elective') {
      closeDetail();
      showElectiveDetail(p.name);
      return;
    }

    else if (p.type === 'committee') {
      var committee = null;
      VOLUNTEER_COMMITTEES.forEach(function(c) { if (c.name === p.name) committee = c; });
      if (!committee) return;
      html += '<h3>' + committee.name + '</h3>';
      html += '<div class="elective-staff-list">';
      if (committee.chair && committee.chair.person) {
        html += '<div class="elective-teacher">';
        html += '<div class="staff-dot" style="background:' + faceColor(committee.chair.person) + ';width:36px;height:36px;"><span style="font-size:0.85rem;">' + committee.chair.person.charAt(0) + '</span></div>';
        html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + committee.chair.person + '</strong><small style="color:var(--color-text-light);">' + committee.chair.title + ' (Chair)</small></div>';
        html += '</div>';
      }
      committee.roles.forEach(function(r) {
        var person = r.person || 'Open';
        html += '<div class="elective-teacher">';
        html += '<div class="staff-dot" style="background:' + (r.person ? faceColor(person) : '#ccc') + ';width:36px;height:36px;"><span style="font-size:0.85rem;">' + person.charAt(0) + '</span></div>';
        html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + person + '</strong><small style="color:var(--color-text-light);">' + r.title + '</small></div>';
        html += '</div>';
      });
      html += '</div>';
    }

    else if (p.type === 'cleaning') {
      // Cleaning task descriptions by area
      var CLEANING_TASKS = {
        'Classrooms & MPR': [
          'Remove bagged trash from the rooms and place in the hall by the entranceway',
          'Replace trash bags in the cans in each room',
          'Sweep as needed',
          'Wipe surfaces as needed',
          'Reset chairs around tables as needed',
          'Turn off lights to show rooms are cleaned'
        ],
        'Kitchen': [
          'Remove bagged trash from the kitchen and place in the hall by the entranceway',
          'Replace trash bags in the kitchen',
          'Sweep as needed',
          'Wipe surfaces as needed',
          'Take home kitchen towels to launder and return the following week',
          'Ensure the coffee pot(s) are off and unplugged',
          'Ensure the ovens are off',
          'Ensure the freezer & refrigerator doors are securely closed',
          'Turn off lights to show kitchen is cleaned'
        ],
        'Kitchen Annex & FH': [
          'Remove bagged trash from the kitchen annex and FH and place in the hall by the entranceway',
          'Replace trash bags in the kitchen annex and FH',
          'Sweep or vacuum as needed',
          'Wipe surfaces as needed',
          'Reset chairs, tables, and other items (in FH) as needed',
          'Turn off lights to show rooms are cleaned'
        ],
        'Hallways': [
          'Sweep or vacuum as needed',
          'Wipe surfaces as needed',
          'Clean entryway floors (sweep) and glass doors (glass cleaner)',
          'Turn off lights to show halls are cleaned'
        ],
        'Bathrooms': [
          'Remove trash in bags and place in the hall by the entranceway',
          'Replace trash bags in all bathrooms',
          'Wipe surfaces with disinfecting wipes',
          'Turn off lights to show bathrooms are cleaned'
        ],
        'Classrooms': [
          'Remove bagged trash from the rooms and place in the hall by the entranceway',
          'Replace trash bags in the cans in each room',
          'Sweep as needed',
          'Wipe surfaces as needed',
          'Reset chairs around tables as needed',
          'Turn off lights to show rooms are cleaned'
        ],
        'Halls & Stairs': [
          'Sweep/Vacuum as needed',
          'Wipe surfaces, including handrails, as needed',
          'Turn off lights to show areas are cleaned'
        ],
        'Garage & Grounds': [
          'Remove trash from the garage/pavilion',
          'Replace trash bag in the garage/pavilion',
          'Spot check the playground and surrounding areas for trash and debris',
          'Take ALL trash (inside trash should be placed by the entranceway) to the dumpster — wait until inside trash has been collected',
          'Turn off light to show garage is cleaned',
          'Close and lock garage doors'
        ],
        'Floater': [
          'Available to cover any last-minute absences from the Cleaning Crew',
          'Familiar with all cleaning area tasks',
          'Not necessarily the one to cover planned/advance notice absences'
        ]
      };

      html += '<h3>Cleaning Crew &mdash; Session ' + p.session + '</h3>';

      // Show your assigned area tasks first
      var yourTasks = CLEANING_TASKS[p.area] || CLEANING_TASKS[p.area.replace(/\s*$/, '')] || null;
      if (yourTasks) {
        html += '<div style="background:var(--color-primary-ghost);border-radius:12px;padding:1rem;margin-bottom:1rem;">';
        html += '<h4 style="margin:0 0 0.75rem;font-size:0.95rem;">Your Assignment: ' + p.area + '</h4>';
        html += '<ul style="margin:0;padding-left:1.25rem;font-size:0.85rem;line-height:1.6;">';
        yourTasks.forEach(function(task) {
          html += '<li>' + task + '</li>';
        });
        html += '</ul></div>';
      }

      // Show full crew list
      var sessClean = CLEANING_CREW.sessions[p.session];
      if (sessClean) {
        html += '<h4 style="margin:0.5rem 0;font-size:0.9rem;">Full Crew</h4>';
        var floorLabels = {mainFloor: 'Main Floor', upstairs: 'Upstairs', outside: 'Outside'};
        ['mainFloor', 'upstairs', 'outside'].forEach(function(floor) {
          if (!sessClean[floor] || Object.keys(sessClean[floor]).length === 0) return;
          html += '<h4 style="margin:0.75rem 0 0.4rem;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--color-text-light);">' + floorLabels[floor] + '</h4>';
          html += '<div class="elective-staff-list">';
          Object.keys(sessClean[floor]).forEach(function(area) {
            sessClean[floor][area].forEach(function(person) {
              var isYou = p.area === area && p.floor === floor;
              html += '<div class="elective-teacher"' + (isYou ? ' style="background:var(--color-primary-ghost);border-radius:8px;padding:4px 8px;"' : '') + '>';
              html += '<div class="staff-dot" style="background:' + faceColor(person) + ';width:32px;height:32px;"><span style="font-size:0.8rem;">' + person.charAt(0) + '</span></div>';
              html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + person + '</strong><small style="color:var(--color-text-light);">' + area + '</small></div>';
              html += '</div>';
            });
          });
          html += '</div>';
        });
        if (sessClean.floater && sessClean.floater.length > 0) {
          html += '<h4 style="margin:0.75rem 0 0.4rem;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--color-text-light);">Floater</h4>';
          html += '<div class="elective-staff-list">';
          sessClean.floater.forEach(function(person) {
            var isYou = p.area === 'Floater';
            html += '<div class="elective-teacher"' + (isYou ? ' style="background:var(--color-primary-ghost);border-radius:8px;padding:4px 8px;"' : '') + '>';
            html += '<div class="staff-dot" style="background:' + faceColor(person) + ';width:32px;height:32px;"><span style="font-size:0.8rem;">' + person.charAt(0) + '</span></div>';
            html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + person + '</strong><small style="color:var(--color-text-light);">Floater</small></div>';
            html += '</div>';
          });
          html += '</div>';
        }
        html += '<p style="margin-top:1rem;font-size:0.8rem;color:var(--color-text-light);">Liaison: ' + CLEANING_CREW.liaison + '</p>';
      }
    }

    else if (p.type === 'event') {
      var ev = null;
      SPECIAL_EVENTS.forEach(function(e) { if (e.name === p.name) ev = e; });
      if (!ev) return;
      html += '<h3>' + ev.name + '</h3>';
      html += '<div class="elective-meta">';
      html += '<span>' + ev.date + '</span>';
      html += '</div>';
      html += '<div class="elective-staff-list">';
      if (ev.coordinator) {
        html += '<div class="elective-teacher">';
        html += '<div class="staff-dot" style="background:' + faceColor(ev.coordinator) + ';width:36px;height:36px;"><span style="font-size:0.85rem;">' + ev.coordinator.charAt(0) + '</span></div>';
        html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + ev.coordinator + '</strong><small style="color:var(--color-text-light);">Coordinator</small></div>';
        html += '</div>';
      }
      if (ev.planningSupport) {
        ev.planningSupport.forEach(function(s, i) {
          var person = s || 'Open';
          html += '<div class="elective-teacher">';
          html += '<div class="staff-dot" style="background:' + (s ? faceColor(person) : '#ccc') + ';width:36px;height:36px;"><span style="font-size:0.85rem;">' + person.charAt(0) + '</span></div>';
          html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + person + '</strong><small style="color:var(--color-text-light);">Planning Support</small></div>';
          html += '</div>';
        });
      }
      html += '</div>';
    }

    else if (p.type === 'board') {
      // Find the committee this board member chairs
      var committee = null;
      VOLUNTEER_COMMITTEES.forEach(function(c) {
        if (c.chair && nameMatch(c.chair.title, p.role)) committee = c;
      });
      html += '<h3>' + p.role + '</h3>';
      html += '<p style="color:var(--color-text-light);margin-bottom:1rem;">Board of Directors &middot; 2-year term</p>';
      if (committee) {
        html += '<h4 style="margin-bottom:0.5rem;">' + committee.name + '</h4>';
        html += '<div class="elective-staff-list">';
        committee.roles.forEach(function(r) {
          var person = r.person || 'Open';
          html += '<div class="elective-teacher">';
          html += '<div class="staff-dot" style="background:' + (r.person ? faceColor(person) : '#ccc') + ';width:36px;height:36px;"><span style="font-size:0.85rem;">' + person.charAt(0) + '</span></div>';
          html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + person + '</strong><small style="color:var(--color-text-light);">' + r.title + '</small></div>';
          html += '</div>';
        });
        html += '</div>';
      }
    }

    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) {
      if (e.target === personDetail) closeDetail();
    });
  }

  // Board-only detail (when person isn't in directory data yet)
  function showBoardOnlyDetail(fullName, boardInfo) {
    if (!personDetail || !personDetailCard) return;
    var emailSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>';
    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="detail-header">';
    var boardLast = fullName.trim().split(/\s+/).pop();
    var boardPhotoUrl = getPhotoUrl(fullName, boardInfo.email, boardLast);
    if (boardPhotoUrl) {
      var hiResBoardDetail = boardPhotoUrl.replace(/=s\d+-c/, '=s256-c');
      html += '<div class="detail-photo" style="background:' + faceColor(fullName) + '"><img src="' + hiResBoardDetail + '" alt="' + fullName + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'\'"><span style="display:none">' + fullName.charAt(0) + '</span></div>';
    } else {
      html += '<div class="detail-photo" style="background:' + faceColor(fullName) + '"><span>' + fullName.charAt(0) + '</span></div>';
    }
    html += '<div class="detail-info">';
    html += '<h3>' + fullName + '</h3>';
    html += '<p class="detail-board-role">' + boardInfo.role + '</p>';
    html += '</div></div>';
    html += '<div class="detail-contact">';
    html += '<a href="mailto:' + boardInfo.email + '" class="detail-btn detail-btn-board">';
    html += emailSvg + ' ' + boardInfo.email + '</a>';
    html += '</div>';
    if (boardInfo.responsibilities) {
      html += '<div class="detail-responsibilities">';
      html += '<h4>' + boardInfo.responsibilities.committee + '</h4>';
      html += '<ul>';
      boardInfo.responsibilities.bullets.forEach(function (b) {
        html += '<li>' + b + '</li>';
      });
      html += '</ul></div>';
    }
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) {
      if (e.target === personDetail) closeDetail();
    });
  }

  // Close on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeDetail();
  });

  // Filter pills
  document.querySelectorAll('.filter-pill').forEach(function (pill) {
    pill.addEventListener('click', function () {
      document.querySelectorAll('.filter-pill').forEach(function (p) { p.classList.remove('active'); });
      this.classList.add('active');
      activeFilter = this.getAttribute('data-filter');
      renderDirectory();
    });
  });

  // Search
  if (directorySearch) {
    directorySearch.addEventListener('input', function () {
      renderDirectory();
    });
  }

  // Initial render
  renderDirectory();

  // Board card click handlers
  document.querySelectorAll('.portal-board-card[data-board]').forEach(function (card) {
    card.style.cursor = 'pointer';
    card.addEventListener('click', function (e) {
      if (e.target.closest('a')) return;
      var fullName = this.getAttribute('data-board');
      var boardRole = this.getAttribute('data-board-role');
      var boardEmail = this.getAttribute('data-board-email');
      var familyName = this.getAttribute('data-board-family');
      var resp = BOARD_RESPONSIBILITIES[boardRole];
      var boardInfo = {role: boardRole, email: boardEmail, responsibilities: resp || null};

      // Try to find by explicit family mapping first, then by full name
      var found = null;
      if (familyName) {
        var first = fullName.split(' ')[0];
        for (var i = 0; i < allPeople.length; i++) {
          if (allPeople[i].name === first && allPeople[i].family === familyName) {
            found = {person: allPeople[i], idx: i};
            break;
          }
        }
      }
      if (!found) found = findPersonByFullName(fullName);

      if (found) {
        showPersonDetail(found.person, boardInfo);
      } else {
        // Board member not in directory yet — show basic card
        showBoardOnlyDetail(fullName, boardInfo);
      }
    });
  });

  // ──────────────────────────────────────────────
  // 7c. My Family Dashboard
  // ──────────────────────────────────────────────

  // SVG icons for duties
  // ── Board responsibilities (contact-for guidance) ──
  var BOARD_RESPONSIBILITIES = {
    'President': {
      committee: 'Facility Committee',
      bullets: ['Building & grounds oversight', 'FMC relationship & facility coordination']
    },
    'Vice President': {
      committee: 'Programming Committee',
      bullets: ['Class planning & session scheduling', 'Supporting class leads & assistants']
    },
    'Treasurer': {
      committee: 'Finance Committee',
      bullets: ['Billing, fees & reimbursements', 'Financial assistance & fundraising']
    },
    'Membership Director': {
      committee: 'Membership Committee',
      bullets: ['Enrollment & new family onboarding', 'Registration & class placement']
    },
    'Communications Director': {
      committee: 'Communications Committee',
      bullets: ['Google Workspace & member comms', 'Surveys, yearbook & newsletter']
    },
    'Secretary': {
      committee: 'Administrative Committee',
      bullets: ['Meeting minutes & official records', 'Government filings & archives']
    },
    'Sustaining Director': {
      committee: 'Support Committee',
      bullets: ['Member retention & satisfaction', 'Special event support & burnout monitoring']
    }
  };

  // ── Stub billing data (to be replaced with Google Sheets API) ──
  // Each family key is the family name (matches FAMILIES[].name)
  // amounts are per-semester; lineItems show the breakdown
  var BILLING_CONFIG = {
    memberFeePerSemester: 40,
    amFeePerSession: 10,
    pmFeePerSession: 10,
    paypalFeeRate: 0.0199,
    paypalFeeFixed: 0.49,
    checkPayableTo: 'Roots and Wings Homeschool, Inc.',
    checkDeliverTo: 'Jessica Shewan (Treasurer)',
    paypalMerchantId: 'MHDL7HTNRVQHE',
    semesters: {
      fall: { name: 'Fall 2025', sessions: [1, 2], dueDate: '2025-08-27', deposit: 50, depositStatus: 'Paid', status: 'Paid' },
      spring: { name: 'Spring 2026', sessions: [3, 4, 5], dueDate: '2026-01-07', deposit: 50, depositStatus: 'Paid', status: 'Due' }
    }
  };

  function calculateSessionFees(fam, sessionNum) {
    var lineItems = [];
    var programmingKids = fam.kids.filter(function(k) { return k.group !== 'Greenhouse'; });
    var fullDayKids = programmingKids.filter(function(k) { return !k.schedule || k.schedule === 'all-day'; });
    var morningOnly = programmingKids.filter(function(k) { return k.schedule === 'morning'; });
    var afternoonOnly = programmingKids.filter(function(k) { return k.schedule === 'afternoon'; });

    if (fullDayKids.length > 0) {
      var amAmt = fullDayKids.length * BILLING_CONFIG.amFeePerSession;
      var pmAmt = fullDayKids.length * BILLING_CONFIG.pmFeePerSession;
      lineItems.push({ label: 'AM classes (' + fullDayKids.length + (fullDayKids.length === 1 ? ' kid' : ' kids') + ' \u00d7 $' + BILLING_CONFIG.amFeePerSession + ')', amount: amAmt });
      lineItems.push({ label: 'PM classes (' + fullDayKids.length + (fullDayKids.length === 1 ? ' kid' : ' kids') + ' \u00d7 $' + BILLING_CONFIG.pmFeePerSession + ')', amount: pmAmt });
    }
    if (morningOnly.length > 0) {
      lineItems.push({ label: 'AM only (' + morningOnly.map(function(k){return k.name;}).join(', ') + ')', amount: morningOnly.length * BILLING_CONFIG.amFeePerSession });
    }
    if (afternoonOnly.length > 0) {
      lineItems.push({ label: 'PM only (' + afternoonOnly.map(function(k){return k.name;}).join(', ') + ')', amount: afternoonOnly.length * BILLING_CONFIG.pmFeePerSession });
    }

    var subtotal = 0;
    lineItems.forEach(function(li) { subtotal += li.amount; });
    return { lineItems: lineItems, subtotal: subtotal, sessionNum: sessionNum };
  }

  function calculateSemesterFees(fam, semesterKey) {
    var sem = BILLING_CONFIG.semesters[semesterKey];
    if (!sem) return null;
    var sessionFees = [];
    var classTotal = 0;
    sem.sessions.forEach(function(sNum) {
      var sf = calculateSessionFees(fam, sNum);
      sessionFees.push(sf);
      classTotal += sf.subtotal;
    });
    var memberFee = BILLING_CONFIG.memberFeePerSemester;
    var deposit = sem.deposit || 0;
    var subtotal = memberFee + classTotal;
    var balanceBeforeFee = subtotal - deposit;
    var paypalFee = Math.ceil(((balanceBeforeFee + BILLING_CONFIG.paypalFeeFixed) / (1 - BILLING_CONFIG.paypalFeeRate) - balanceBeforeFee) * 100) / 100;
    var total = balanceBeforeFee + paypalFee;
    return {
      name: sem.name,
      status: sem.status || 'Due',
      depositStatus: sem.depositStatus || 'Due',
      dueDate: sem.dueDate,
      memberFee: memberFee,
      deposit: deposit,
      sessionFees: sessionFees,
      classTotal: classTotal,
      subtotal: subtotal,
      balanceBeforeFee: balanceBeforeFee,
      paypalFee: paypalFee,
      total: total,
      sessionCount: sem.sessions.length
    };
  }

  var DUTY_ICONS = {
    teach: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
    assist: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    star: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    board: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
    clean: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    event: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    volunteer: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
  };

  // Helper: find a kid's afternoon electives for the current session
  function getKidElectives(kidFullName) {
    var sessElectives = PM_ELECTIVES[currentSession] || [];
    var result = [];
    var parts = kidFullName.toLowerCase().split(/\s+/);
    var kidFirst = parts[0];
    var kidLast = parts.slice(1).join(' ');
    sessElectives.forEach(function (elec) {
      var found = elec.students.some(function(st) {
        var stLower = st.toLowerCase().trim();
        // Exact match
        if (stLower === kidFullName.toLowerCase()) return true;
        // Match by last name + first name starts with (handles nicknames like Junie/Juniper)
        var stParts = stLower.split(/\s+/);
        var stFirst = stParts[0];
        var stLast = stParts.slice(1).join(' ');
        if (kidLast && stLast === kidLast && (stFirst.indexOf(kidFirst) === 0 || kidFirst.indexOf(stFirst) === 0)) return true;
        return false;
      });
      if (found) result.push(elec);
    });
    // Sort by hour
    result.sort(function (a, b) {
      var ha = a.hour === 'both' ? 1 : a.hour;
      var hb = b.hour === 'both' ? 1 : b.hour;
      return ha - hb;
    });
    return result;
  }

  // Helper: append age range to group name, e.g., "Sassafras (3-6)"
  // Also handles "Teens" alias for "Pigeons"
  function groupWithAge(groupName) {
    var displayName = groupName;
    var lookupName = groupName;
    if (groupName === 'Teens') lookupName = 'Pigeons';
    var cls = AM_CLASSES[lookupName];
    if (cls && cls.ages) return displayName + ' (' + cls.ages + ')';
    return displayName;
  }

  // Helper: get time string from hour
  function electiveTime(hour) {
    if (hour === 1) return '1:00\u20131:55';
    if (hour === 2) return '2:00\u20132:55';
    return '1:00\u20132:55';
  }

  function renderMyFamily() {
    var email = sessionStorage.getItem('rw_user_email');
    var section = document.getElementById('myFamily');
    var grid = document.getElementById('myFamilyGrid');
    var greeting = document.getElementById('dashboardGreeting');
    if (!email || !section || !grid) return;

    // Find the family by email
    var fam = null;
    for (var i = 0; i < FAMILIES.length; i++) {
      if (FAMILIES[i].email === email) { fam = FAMILIES[i]; break; }
    }
    if (!fam) return;

    // Personalize greeting
    var firstName = fam.parents.split(' & ')[0].split(' ')[0];
    if (greeting) greeting.textContent = 'Welcome, ' + firstName + '!';

    var html = '';

    // ──── Kids' schedule card ────
    html += '<div class="mf-card">';
    html += '<h3 class="mf-card-title">Kids\' Schedule &mdash; Session ' + currentSession + '</h3>';
    fam.kids.forEach(function (kid) {
      var staff = AM_CLASSES[kid.group];
      var sess = staff ? staff.sessions[currentSession] : null;
      var room = sess ? sess.room : '';
      var teacher = sess ? sess.teacher : 'TBD';
      var topic = sess ? sess.topic : '';
      var displayLast = kid.lastName || fam.name;
      var kidFull = kid.name + ' ' + displayLast;

      // Get afternoon electives
      var electives = getKidElectives(kidFull);

      html += '<div class="mf-kid">';
      // Kid header bar
      html += '<div class="mf-kid-bar">';
      html += '<div class="mf-kid-photo" style="background:' + faceColor(kid.name) + '"><span>' + kid.name.charAt(0) + '</span></div>';
      html += '<strong class="mf-kid-name">' + kid.name + '</strong>';
      html += '<button class="mf-class-link" data-group="' + kid.group + '">View Classmates &rarr;</button>';
      html += '</div>';

      // Schedule table
      html += '<div class="mf-schedule">';

      // Morning
      html += '<div class="mf-sched-row">';
      html += '<span class="mf-sched-time">AM</span>';
      html += '<span class="mf-sched-class">' + groupWithAge(kid.group) + (topic ? '<br><em style="font-weight:400;">' + topic + '</em>' : '') + '</span>';
      html += '<span class="mf-sched-room">' + room + '</span>';
      html += '<span class="mf-sched-teacher">' + teacher + '</span>';
      html += '</div>';

      // Afternoon electives
      if (electives.length > 0) {
        electives.forEach(function (e) {
          var label = e.hour === 'both' ? 'PM' : e.hour === 1 ? 'PM 1' : 'PM 2';
          html += '<div class="mf-sched-row">';
          html += '<span class="mf-sched-time">' + label + '</span>';
          html += '<button class="mf-elective-link mf-sched-class" data-elective="' + e.name + '">' + e.name + '</button>';
          html += '<span class="mf-sched-room">' + e.room + '</span>';
          html += '<span class="mf-sched-teacher">' + e.leader + '</span>';
          html += '</div>';
        });
      } else {
        html += '<div class="mf-sched-row mf-sched-empty">';
        html += '<span class="mf-sched-time">PM</span>';
        html += '<span class="mf-sched-class mf-empty-text">No electives yet</span>';
        html += '</div>';
      }

      html += '</div></div>';
    });
    html += '</div>';

    // ──── Responsibilities card ────
    html += '<div class="mf-card">';
    html += '<h3 class="mf-card-title">Your Responsibilities</h3>';
    var duties = [];
    var parentFullNames = fam.parents.split(' & ').map(function(p) { return p.trim() + ' ' + fam.name; });

    // Teaching / assisting (morning classes)
    var groups = Object.keys(AM_CLASSES);
    groups.forEach(function (groupName) {
      var staff = AM_CLASSES[groupName];
      var sess = staff.sessions[currentSession];
      if (!sess) return;

      // Liaison
      parentFullNames.forEach(function (full) {
        if (nameMatch(staff.liaison, full)) {
          duties.push({icon: 'star', text: groupWithAge(groupName) + ' Class Liaison', detail: 'Year-long role', popup: {type: 'amClass', group: groupName, session: currentSession}});
        }
        if (nameMatch(sess.teacher, full)) {
          duties.push({icon: 'teach', text: 'Leading ' + groupWithAge(groupName), detail: '10:00\u201312:00 \u00b7 ' + (sess.room || ''), popup: {type: 'amClass', group: groupName, session: currentSession}});
        }
        sess.assistants.forEach(function (a) {
          if (nameMatch(a, full)) {
            duties.push({icon: 'assist', text: 'Assisting ' + groupWithAge(groupName), detail: '10:00\u201312:00 \u00b7 ' + (sess.room || ''), popup: {type: 'amClass', group: groupName, session: currentSession}});
          }
        });
      });
    });

    // Teaching/assisting afternoon electives
    var sessElectives = PM_ELECTIVES[currentSession] || [];
    sessElectives.forEach(function (elec) {
      parentFullNames.forEach(function (full) {
        if (nameMatch(elec.leader, full)) {
          duties.push({icon: 'teach', text: 'Leading ' + elec.name, detail: electiveTime(elec.hour) + ' \u00b7 Afternoon elective', popup: {type: 'elective', name: elec.name}});
        }
        if (elec.assistants) {
          elec.assistants.forEach(function(a) {
            if (nameMatch(a, full)) {
              duties.push({icon: 'assist', text: 'Assisting ' + elec.name, detail: electiveTime(elec.hour) + ' \u00b7 Afternoon elective', popup: {type: 'elective', name: elec.name}});
            }
          });
        }
      });
    });

    // Board role
    if (fam.boardRole) {
      duties.push({icon: 'board', text: fam.boardRole, detail: 'Board of Directors &middot; 2-year term', popup: {type: 'board', role: fam.boardRole}});
    }

    // Volunteer committees (year-long) — fuzzy match to handle live data name variations
    function nameMatch(a, b) {
      if (!a || !b) return false;
      return a.trim().toLowerCase() === b.trim().toLowerCase();
    }
    VOLUNTEER_COMMITTEES.forEach(function (committee) {
      if (committee.chair && committee.chair.person) {
        // Skip if this chair role is already listed as a board role
        // Handle abbreviated titles (e.g., "Communications Dir." vs "Communications Director")
        var chairTitle = committee.chair.title.replace(/\bDir\.\s*$/, 'Director');
        if (!fam.boardRole || !nameMatch(chairTitle, fam.boardRole)) {
          parentFullNames.forEach(function (full) {
            if (nameMatch(committee.chair.person, full)) {
              duties.push({icon: 'volunteer', text: committee.chair.title + ' (' + committee.name + ')', detail: 'Board &middot; Year-long', popup: {type: 'committee', name: committee.name}});
            }
          });
        }
      }
      committee.roles.forEach(function (r) {
        parentFullNames.forEach(function (full) {
          if (nameMatch(r.person, full)) {
            duties.push({icon: 'volunteer', text: r.title, detail: committee.name + ' &middot; Year-long', popup: {type: 'committee', name: committee.name}});
          }
        });
      });
    });

    // Cleaning crew — match by family last name or any parent full name
    var sessClean = CLEANING_CREW.sessions[currentSession];
    if (sessClean) {
      var cleanAreas = ['mainFloor', 'upstairs', 'outside'];
      function matchesCleaning(names) {
        return names.some(function(n) {
          var nl = n.toLowerCase();
          return nl === fam.name.toLowerCase() ||
            parentFullNames.some(function(pf) { return nl.indexOf(pf.split(' ')[0].toLowerCase()) !== -1 && nl.indexOf(fam.name.toLowerCase()) !== -1; }) ||
            parentFullNames.some(function(pf) { return nl === pf.toLowerCase(); });
        });
      }
      cleanAreas.forEach(function (floor) {
        if (!sessClean[floor]) return;
        var areas = Object.keys(sessClean[floor]);
        areas.forEach(function (area) {
          if (matchesCleaning(sessClean[floor][area])) {
            duties.push({icon: 'clean', text: 'Cleaning: ' + area, detail: 'Session ' + currentSession, popup: {type: 'cleaning', area: area, floor: floor, session: currentSession}});
          }
        });
      });
      if (sessClean.floater && matchesCleaning(sessClean.floater)) {
        duties.push({icon: 'clean', text: 'Cleaning Floater', detail: 'Session ' + currentSession, popup: {type: 'cleaning', area: 'Floater', floor: 'floater', session: currentSession}});
      }
    }

    // Special events
    SPECIAL_EVENTS.forEach(function (ev) {
      var isCoord = ev.coordinator && parentFullNames.some(function(full) {
        return ev.coordinator.indexOf(fam.parents.split(' & ')[0].split(' ')[0]) !== -1;
      });
      var statusClass = ev.status === 'Complete' ? 'mf-status-done' : ev.status === 'Needs Volunteers' ? 'mf-status-open' : 'mf-status-upcoming';
      if (isCoord) {
        duties.push({icon: 'event', text: ev.name + ' Coordinator', detail: ev.date + ' &middot; <span class="' + statusClass + '">' + ev.status + '</span>', popup: {type: 'event', name: ev.name}});
      }
    });

    if (duties.length === 0) {
      html += '<p class="mf-empty">No assignments found for this session.</p>';
    } else {
      duties.forEach(function (d, di) {
        html += '<div class="mf-duty mf-duty-clickable" data-duty-idx="' + di + '" style="cursor:pointer;">';
        html += '<div class="mf-duty-icon">' + (DUTY_ICONS[d.icon] || '') + '</div>';
        html += '<div class="mf-duty-info"><strong>' + d.text + '</strong><span>' + d.detail + '</span></div>';
        html += '<div class="mf-duty-arrow" style="margin-left:auto;opacity:0.4;font-size:1.1rem;">&rsaquo;</div>';
        html += '</div>';
      });
    }
    html += '</div>';

    // ──── Billing card ────
    html += '<div class="mf-card mf-billing-card">';
    html += '<h3 class="mf-card-title">Billing &amp; Fees</h3>';

    var semKeys = ['fall', 'spring'];

    // ── Each semester: deposit then fees ──
    semKeys.forEach(function (semKey) {
      var sem = calculateSemesterFees(fam, semKey);
      if (!sem) return;

      // Deposit subsection
      if (sem.deposit) {
        var depPaid = sem.depositStatus === 'Paid';
        var depStatusClass = depPaid ? 'mf-billing-paid' : 'mf-billing-due-status';
        html += '<div class="mf-billing-semester">';
        html += '<div class="mf-billing-header">';
        html += '<strong>' + sem.name + ' Deposit</strong>';
        html += '<span class="mf-billing-status ' + depStatusClass + '">' + sem.depositStatus + '</span>';
        html += '</div>';
        html += '<div class="mf-billing-lines">';
        html += '<div class="mf-billing-line mf-billing-total">';
        html += '<span>Deposit (per family)</span>';
        html += '<span>$' + sem.deposit.toFixed(2) + '</span>';
        html += '</div>';
        html += '</div>';
        if (!depPaid) {
          var depBtnId = 'paypal-dep-' + semKey;
          html += '<div class="mf-billing-pay-wrap">';
          html += '<button class="mf-billing-pay-btn" id="' + depBtnId + '">';
          html += '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
          html += ' Pay $' + sem.deposit.toFixed(2) + '</button>';
          html += '</div>';
        }
        html += '</div>';
      }

      // Semester fees subsection
      var isPaid = sem.status === 'Paid';
      var statusClass = isPaid ? 'mf-billing-paid' : 'mf-billing-due-status';
      var dueStr = new Date(sem.dueDate + 'T00:00:00').toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric'});

      html += '<div class="mf-billing-semester">';
      html += '<div class="mf-billing-header">';
      html += '<strong>' + sem.name + '</strong>';
      html += '<span class="mf-billing-status ' + statusClass + '">' + sem.status + '</span>';
      html += '</div>';
      html += '<div class="mf-billing-due">Due: ' + dueStr + '</div>';
      html += '<div class="mf-billing-lines">';

      // Consolidated line items
      var programmingKids = fam.kids.filter(function(k) { return k.group !== 'Greenhouse'; });
      var fullDayKids = programmingKids.filter(function(k) { return !k.schedule || k.schedule === 'all-day'; });
      var nSessions = sem.sessionCount;

      html += '<div class="mf-billing-line">';
      html += '<span>Member fee (per family)</span>';
      html += '<span>$' + sem.memberFee.toFixed(2) + '</span>';
      html += '</div>';

      if (fullDayKids.length > 0) {
        var amTotal = fullDayKids.length * BILLING_CONFIG.amFeePerSession * nSessions;
        var pmTotal = fullDayKids.length * BILLING_CONFIG.pmFeePerSession * nSessions;
        html += '<div class="mf-billing-line">';
        html += '<span>AM class fees (' + fullDayKids.length + (fullDayKids.length === 1 ? ' kid' : ' kids') + ' \u00d7 $' + BILLING_CONFIG.amFeePerSession + ' \u00d7 ' + nSessions + ' sessions)</span>';
        html += '<span>$' + amTotal.toFixed(2) + '</span>';
        html += '</div>';
        html += '<div class="mf-billing-line">';
        html += '<span>PM class fees (' + fullDayKids.length + (fullDayKids.length === 1 ? ' kid' : ' kids') + ' \u00d7 $' + BILLING_CONFIG.pmFeePerSession + ' \u00d7 ' + nSessions + ' sessions)</span>';
        html += '<span>$' + pmTotal.toFixed(2) + '</span>';
        html += '</div>';
      }
      var morningOnly = programmingKids.filter(function(k) { return k.schedule === 'morning'; });
      var afternoonOnly = programmingKids.filter(function(k) { return k.schedule === 'afternoon'; });
      if (morningOnly.length > 0) {
        html += '<div class="mf-billing-line">';
        html += '<span>AM only (' + morningOnly.map(function(k){return k.name;}).join(', ') + ' \u00d7 ' + nSessions + ' sessions)</span>';
        html += '<span>$' + (morningOnly.length * BILLING_CONFIG.amFeePerSession * nSessions).toFixed(2) + '</span>';
        html += '</div>';
      }
      if (afternoonOnly.length > 0) {
        html += '<div class="mf-billing-line">';
        html += '<span>PM only (' + afternoonOnly.map(function(k){return k.name;}).join(', ') + ' \u00d7 ' + nSessions + ' sessions)</span>';
        html += '<span>$' + (afternoonOnly.length * BILLING_CONFIG.pmFeePerSession * nSessions).toFixed(2) + '</span>';
        html += '</div>';
      }

      // Total
      html += '<div class="mf-billing-line mf-billing-total">';
      html += '<span>Total</span>';
      html += '<span>$' + sem.subtotal.toFixed(2) + '</span>';
      html += '</div>';

      // Deposit credit
      if (sem.deposit > 0) {
        html += '<div class="mf-billing-line mf-billing-paid-line">';
        html += '<span>Deposit applied</span>';
        html += '<span>&minus;$' + sem.deposit.toFixed(2) + '</span>';
        html += '</div>';
      }

      // Processing fee
      html += '<div class="mf-billing-line mf-billing-fee-line">';
      html += '<span>Processing fee</span>';
      html += '<span>$' + sem.paypalFee.toFixed(2) + '</span>';
      html += '</div>';

      // Balance due
      html += '<div class="mf-billing-line mf-billing-balance">';
      html += '<span>Balance due</span>';
      html += '<span>$' + sem.total.toFixed(2) + '</span>';
      html += '</div>';
      html += '</div>';

      // Pay button (only if not paid)
      if (!isPaid) {
        var paypalContainerId = 'paypal-btn-' + semKey;
        html += '<div class="mf-billing-pay-wrap">';
        html += '<button class="mf-billing-pay-btn" id="' + paypalContainerId + '">';
        html += '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
        html += ' Pay $' + sem.total.toFixed(2) + '</button>';
        html += '</div>';
      }

      html += '</div>';
    });
    html += '<div class="mf-billing-footer">';
    html += '<p>Also accepted: check payable to <em>' + BILLING_CONFIG.checkPayableTo + '</em>, deliver to ' + BILLING_CONFIG.checkDeliverTo + '</p>';
    html += '<p class="mf-billing-contact">Questions? <a href="mailto:treasurer@rootsandwingsindy.com">treasurer@rootsandwingsindy.com</a></p>';
    html += '</div>';
    html += '</div>';

    grid.innerHTML = html;
    section.style.display = '';

    // Wire up duty detail popups
    grid.querySelectorAll('.mf-duty-clickable').forEach(function (row) {
      row.addEventListener('click', function () {
        var idx = parseInt(this.getAttribute('data-duty-idx'), 10);
        if (duties[idx]) showDutyDetail(duties[idx]);
      });
    });

    // Wire up "View Class" buttons
    grid.querySelectorAll('.mf-class-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var group = this.getAttribute('data-group');
        activeFilter = group;
        document.querySelectorAll('.filter-pill').forEach(function (p) {
          p.classList.toggle('active', p.getAttribute('data-filter') === group);
        });
        renderDirectory();
        var dirSection = document.getElementById('directory');
        if (dirSection) dirSection.scrollIntoView({behavior: 'smooth'});
      });
    });

    // Wire up elective detail links
    grid.querySelectorAll('.mf-elective-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var elecName = this.getAttribute('data-elective');
        showElectiveDetail(elecName);
      });
    });

    // Wire up PayPal pay buttons (semester fees + deposits)
    function wirePaypalButton(btnId, amount, description, invoiceId, email) {
      var btn = document.getElementById(btnId);
      if (!btn || typeof paypal_sdk === 'undefined') return;
      btn.onclick = function () {
        paypal_sdk.Buttons({
          fundingSource: paypal_sdk.FUNDING.PAYPAL,
          style: { layout: 'horizontal', color: 'gold', shape: 'rect', label: 'pay', height: 40 },
          createOrder: function (data, actions) {
            return actions.order.create({
              purchase_units: [{
                amount: { value: amount, currency_code: 'USD' },
                description: description,
                invoice_id: invoiceId,
                custom_id: email
              }]
            });
          },
          onApprove: function (data, actions) {
            return actions.order.capture().then(function (details) {
              var wrap = btn.closest('.mf-billing-pay-wrap');
              wrap.innerHTML = '<div class="mf-billing-success">Payment complete! Transaction ID: ' + details.id + '</div>';
            });
          },
          onError: function (err) {
            var wrap = btn.closest('.mf-billing-pay-wrap');
            wrap.innerHTML = '<div class="mf-billing-error">Payment could not be processed. Please try again or contact <a href="mailto:treasurer@rootsandwingsindy.com">the Treasurer</a>.</div>';
          }
        }).render(btn.closest('.mf-billing-pay-wrap')).then(function () {
          btn.style.display = 'none';
        });
      };
    }

    ['fall', 'spring'].forEach(function (semKey) {
      var sem = calculateSemesterFees(fam, semKey);
      if (!sem) return;
      var capKey = semKey.charAt(0).toUpperCase() + semKey.slice(1);
      // Deposit button
      wirePaypalButton('paypal-dep-' + semKey, sem.deposit.toFixed(2),
        sem.name + ' deposit \u2014 ' + fam.name + ' family',
        'RW-' + capKey + '-Dep-' + fam.name + '-' + new Date().getFullYear(), fam.email);
      // Semester fees button
      wirePaypalButton('paypal-btn-' + semKey, sem.total.toFixed(2),
        sem.name + ' fees \u2014 ' + fam.name + ' family',
        'RW-' + capKey + '-' + fam.name + '-' + new Date().getFullYear(), fam.email);
    });
  }

  // Elective detail popup (enhanced)
  function showElectiveDetail(elecName) {
    // Check the pager's viewed session first, fall back to currentSession
    var viewSess = (typeof sessionTabView !== 'undefined') ? sessionTabView : currentSession;
    var sessElectives = PM_ELECTIVES[viewSess] || [];
    var elec = null;
    for (var i = 0; i < sessElectives.length; i++) {
      if (sessElectives[i].name === elecName) { elec = sessElectives[i]; break; }
    }
    if (!elec || !personDetail || !personDetailCard) return;

    var pct = Math.round((elec.students.length / elec.maxCapacity) * 100);
    var barColor = pct >= 90 ? 'var(--color-error)' : pct >= 70 ? 'var(--color-accent)' : 'var(--color-primary-light)';

    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail">';
    html += '<h3>' + elec.name + '</h3>';
    html += '<div class="elective-meta">';
    html += '<span class="elective-age-pill">' + elec.ageRange + '</span>';
    html += '<span>' + electiveTime(elec.hour) + '</span>';
    html += '<span>' + elec.room + '</span>';
    if (elec.hour === 'both') html += '<span class="elective-both-badge">Both Hours</span>';
    html += '</div>';

    // Description
    html += '<p class="elective-description">' + elec.description + '</p>';

    // Leader + assistants
    html += '<div class="elective-staff-list">';
    html += '<div class="elective-teacher">';
    html += '<div class="staff-dot" style="background:' + faceColor(elec.leader) + ';width:36px;height:36px;"><span style="font-size:0.85rem;">' + elec.leader.charAt(0) + '</span></div>';
    html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + elec.leader + '</strong><small style="color:var(--color-text-light);">Leader</small></div>';
    html += '</div>';
    if (elec.assistants && elec.assistants.length > 0) {
      elec.assistants.forEach(function (a) {
        html += '<div class="elective-teacher">';
        html += '<div class="staff-dot" style="background:' + faceColor(a) + ';width:36px;height:36px;"><span style="font-size:0.85rem;">' + a.charAt(0) + '</span></div>';
        html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + a + '</strong><small style="color:var(--color-text-light);">Assistant</small></div>';
        html += '</div>';
      });
    }
    html += '</div>';

    // Capacity bar
    html += '<div class="elective-capacity">';
    html += '<div class="elective-capacity-label">' + elec.students.length + ' of ' + elec.maxCapacity + ' spots filled</div>';
    html += '<div class="elective-capacity-bar"><div class="elective-capacity-fill" style="width:' + pct + '%;background:' + barColor + '"></div></div>';
    html += '</div>';

    // Student roster
    html += '<h4 class="elective-roster-title">' + elec.students.length + ' Students</h4>';
    html += '<div class="elective-roster">';
    elec.students.forEach(function (kidName) {
      var first = kidName.split(' ')[0];
      var last = kidName.split(' ').slice(1).join(' ');
      html += '<div class="elective-student">';
      html += '<div class="elective-student-dot" style="background:' + faceColor(first) + '"><span>' + first.charAt(0) + '</span></div>';
      html += '<div><strong>' + first + '</strong> <span class="elective-student-last">' + last + '</span></div>';
      html += '</div>';
    });
    html += '</div></div>';

    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) {
      if (e.target === personDetail) closeDetail();
    });
  }

  // ──────────────────────────────────────────────
  // 7d. Coordination Tab Renderers
  // ──────────────────────────────────────────────

  // Track which session each tab is viewing (defaults to currentSession)
  var sessionTabView = currentSession;
  var cleaningTabView = currentSession;

  // Build session pager: « Session 3 | ● Session 4 | Session 5 »
  function buildSessionPager(viewSess, renderFnName) {
    var sessInfo = SESSION_DATES[viewSess];
    var label = sessInfo ? sessInfo.name : 'Session ' + viewSess;
    var isCurrent = viewSess === currentSession;

    var html = '<div class="session-pager">';
    if (viewSess > 1) {
      html += '<button class="session-pager-btn session-pager-prev" data-sess="' + (viewSess - 1) + '" data-render="' + renderFnName + '">';
      html += '&laquo; Session ' + (viewSess - 1);
      html += '</button>';
    } else {
      html += '<span class="session-pager-btn session-pager-disabled">&laquo;</span>';
    }

    html += '<span class="session-pager-current' + (isCurrent ? ' session-pager-active' : '') + '">';
    html += label;
    if (isCurrent) html += ' <span class="session-pager-now">Current</span>';
    html += '</span>';

    if (viewSess < 5) {
      html += '<button class="session-pager-btn session-pager-next" data-sess="' + (viewSess + 1) + '" data-render="' + renderFnName + '">';
      html += 'Session ' + (viewSess + 1) + ' &raquo;';
      html += '</button>';
    } else {
      html += '<span class="session-pager-btn session-pager-disabled">&raquo;</span>';
    }
    html += '</div>';
    return html;
  }

  // Wire up pager buttons inside a container
  function wirePager(container) {
    container.querySelectorAll('.session-pager-btn[data-sess]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var newSess = parseInt(this.getAttribute('data-sess'), 10);
        var renderFn = this.getAttribute('data-render');
        if (renderFn === 'session') {
          sessionTabView = newSess;
          renderSessionTab();
        } else if (renderFn === 'cleaning') {
          cleaningTabView = newSess;
          renderCleaningTab();
        }
      });
    });
  }

  function renderSessionTab() {
    var container = document.getElementById('sessionTabContent');
    if (!container) return;
    var viewSess = sessionTabView;
    var sess = SESSION_DATES[viewSess];
    var electives = PM_ELECTIVES[viewSess] || [];

    var html = buildSessionPager(viewSess, 'session');

    // Morning classes table
    html += '<h4 class="session-section-title">Morning Classes &mdash; 10:00\u201312:00</h4>';
    html += '<div class="directory-table-wrap"><table class="portal-table"><thead><tr><th>Group</th><th>Ages</th><th>Topic</th><th>Leader</th><th>Room</th></tr></thead><tbody>';
    var groups = Object.keys(AM_CLASSES);
    groups.forEach(function (groupName) {
      var cls = AM_CLASSES[groupName];
      var s = cls.sessions[viewSess];
      if (!s) return;
      html += '<tr class="session-class-row" data-group="' + groupName + '">';
      html += '<td><span class="session-group-link">' + groupName + '</span></td>';
      html += '<td>' + cls.ages + '</td>';
      html += '<td>' + s.topic + '</td>';
      html += '<td>' + s.teacher + '</td>';
      html += '<td>' + s.room + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div>';

    // Afternoon electives by hour
    if (electives.length > 0) {
      var hour1 = electives.filter(function (e) { return e.hour === 1 || e.hour === 'both'; });
      var hour2 = electives.filter(function (e) { return e.hour === 2 || e.hour === 'both'; });

      html += '<h4 class="session-section-title">Afternoon Electives &mdash; Hour 1: 1:00\u20131:55</h4>';
      html += '<div class="elective-card-grid">';
      hour1.forEach(function (e) { html += buildElectiveCard(e); });
      html += '</div>';

      html += '<h4 class="session-section-title">Afternoon Electives &mdash; Hour 2: 2:00\u20132:55</h4>';
      html += '<div class="elective-card-grid">';
      hour2.forEach(function (e) { html += buildElectiveCard(e); });
      html += '</div>';
    } else {
      html += '<p style="color:var(--color-text-light);margin-top:20px;"><em>Afternoon elective sign-ups not yet available for this session.</em></p>';
    }

    container.innerHTML = html;

    // Wire up pager
    wirePager(container);

    // Wire up elective card clicks
    container.querySelectorAll('.elective-card').forEach(function (card) {
      card.addEventListener('click', function () {
        showElectiveDetail(this.getAttribute('data-elective'));
      });
    });

    // Wire up full row clicks → jump to directory with that class filter
    container.querySelectorAll('.session-class-row').forEach(function (row) {
      row.onclick = function () {
        var group = this.getAttribute('data-group');
        activeFilter = group;
        document.querySelectorAll('.filter-pill').forEach(function (p) {
          p.classList.toggle('active', p.getAttribute('data-filter') === group);
        });
        renderDirectory();
        var dirSection = document.getElementById('directory');
        if (dirSection) dirSection.scrollIntoView({ behavior: 'smooth' });
      };
    });
  }

  function buildElectiveCard(e) {
    var pct = Math.round((e.students.length / e.maxCapacity) * 100);
    var barColor = pct >= 90 ? 'var(--color-error)' : pct >= 70 ? 'var(--color-accent)' : 'var(--color-primary-light)';
    var html = '<button class="elective-card" data-elective="' + e.name + '">';
    html += '<div class="elective-card-header">';
    html += '<span class="elective-card-name">' + e.name + '</span>';
    html += '<span class="elective-age-pill">' + e.ageRange + '</span>';
    html += '</div>';
    if (e.hour === 'both') html += '<span class="elective-both-badge">Both Hours</span>';
    html += '<p class="elective-card-desc">' + e.description + '</p>';
    html += '<div class="elective-card-meta">' + e.room + ' &middot; ' + e.leader + '</div>';
    html += '<div class="elective-capacity-bar"><div class="elective-capacity-fill" style="width:' + pct + '%;background:' + barColor + '"></div></div>';
    html += '<div class="elective-card-spots">' + e.students.length + '/' + e.maxCapacity + '</div>';
    html += '</button>';
    return html;
  }

  function renderCleaningTab() {
    var container = document.getElementById('cleaningTabContent');
    if (!container) return;
    var viewSess = cleaningTabView;
    var sessClean = CLEANING_CREW.sessions[viewSess];

    var html = buildSessionPager(viewSess, 'cleaning');
    html += '<p style="color:var(--color-text-light);margin-bottom:16px;">Liaison: <strong>' + CLEANING_CREW.liaison + '</strong></p>';

    if (!sessClean) {
      html += '<p style="color:var(--color-text-light);"><em>Cleaning assignments not yet available for this session.</em></p>';
      container.innerHTML = html;
      wirePager(container);
      return;
    }

    var floors = [
      { key: 'mainFloor', label: 'Main Floor' },
      { key: 'upstairs', label: 'Upstairs' },
      { key: 'outside', label: 'Outside' }
    ];

    html += '<div class="cleaning-grid">';
    floors.forEach(function (floor) {
      if (!sessClean[floor.key]) return;
      html += '<div class="cleaning-floor-card">';
      html += '<h4>' + floor.label + '</h4>';
      var areas = Object.keys(sessClean[floor.key]);
      areas.forEach(function (area) {
        var families = sessClean[floor.key][area];
        html += '<div class="cleaning-role">';
        html += '<span class="cleaning-area">' + area + '</span>';
        html += '<span class="cleaning-families">' + families.map(function (f) { return f + ' family'; }).join(', ') + '</span>';
        html += '</div>';
      });
      html += '</div>';
    });

    if (sessClean.floater && sessClean.floater.length > 0) {
      html += '<div class="cleaning-floor-card">';
      html += '<h4>Floater</h4>';
      html += '<div class="cleaning-role"><span class="cleaning-families">' + sessClean.floater.map(function (f) { return f + ' family'; }).join(', ') + '</span></div>';
      html += '</div>';
    }
    html += '</div>';

    container.innerHTML = html;
    wirePager(container);
  }

  function renderVolunteersTab() {
    var container = document.getElementById('volunteersTabContent');
    if (!container) return;

    var html = '<h3>Volunteer Committees &mdash; 2025\u20132026</h3>';
    html += '<div class="portal-volunteer-grid">';

    VOLUNTEER_COMMITTEES.forEach(function (committee) {
      html += '<div class="portal-role-card">';
      html += '<h4>' + committee.name + '</h4>';
      if (committee.chair) {
        html += '<div class="committee-chair"><strong>' + committee.chair.title + ':</strong> ' + committee.chair.person + '</div>';
      }
      html += '<ul>';
      committee.roles.forEach(function (r) {
        var personText = r.person ? r.person : '<em>Open</em>';
        html += '<li><strong>' + r.title + ':</strong> ' + personText + '</li>';
      });
      html += '</ul></div>';
    });
    html += '</div>';

    container.innerHTML = html;
  }

  function renderEventsTab() {
    var container = document.getElementById('eventsTabContent');
    if (!container) return;

    var html = '<h3>Special Events &mdash; 2025\u20132026</h3>';
    html += '<div class="events-grid">';

    SPECIAL_EVENTS.forEach(function (ev) {
      var statusClass = ev.status === 'Complete' ? 'status-done' : ev.status === 'Needs Volunteers' ? 'status-open' : 'status-upcoming';
      var coordText = ev.coordinator || '<em class="event-open-slot">Needs volunteer</em>';
      var filled = ev.planningSupport.filter(function (s) { return s !== ''; }).length;

      html += '<div class="event-card">';
      html += '<div class="event-card-header">';
      html += '<div>';
      html += '<strong class="event-card-name">' + ev.name + '</strong>';
      html += '<div class="event-card-date">' + ev.date + '</div>';
      html += '</div>';
      html += '<span class="status-badge ' + statusClass + '">' + ev.status + '</span>';
      html += '</div>';

      // Coordinator
      html += '<div class="event-roles">';
      html += '<div class="event-role">';
      html += '<span class="event-role-label">Coordinator</span>';
      html += '<span class="event-role-person">' + coordText + '</span>';
      html += '</div>';

      // Planning support slots
      ev.planningSupport.forEach(function (person, idx) {
        html += '<div class="event-role">';
        html += '<span class="event-role-label">Support ' + (idx + 1) + '</span>';
        if (person) {
          html += '<span class="event-role-person">' + person + '</span>';
        } else {
          html += '<span class="event-role-person"><em class="event-open-slot">Open</em></span>';
        }
        html += '</div>';
      });

      // Summary line
      html += '<div class="event-fill-summary">' + filled + ' of ' + ev.maxSupport + ' support spots filled</div>';

      html += '</div></div>';
    });
    html += '</div>';

    container.innerHTML = html;
  }

  function renderIdeasTab() {
    var container = document.getElementById('ideasTabContent');
    if (!container) return;

    var html = '<h3>Class Ideas Board</h3>';
    html += '<p style="color:var(--color-text-light);margin-bottom:20px;">Have an idea for a class? Share it in the <a href="https://docs.google.com/spreadsheets/d/19hR1Am3yzX9YC4jsJ32we-hPxUQ1IwMduz6xvaszMEA/edit?gid=0#gid=0" target="_blank">master spreadsheet</a> or the Google Chat!</p>';
    html += '<div class="ideas-grid">';

    var groups = Object.keys(CLASS_IDEAS);
    groups.forEach(function (group) {
      var ideas = CLASS_IDEAS[group];
      html += '<div class="ideas-card">';
      html += '<h4>' + group + '</h4>';
      html += '<div class="ideas-list">';
      ideas.forEach(function (idea) {
        html += '<span class="idea-chip">' + idea + '</span>';
      });
      html += '</div></div>';
    });
    html += '</div>';

    container.innerHTML = html;
  }

  // Class Ideas popup (from Resources card)
  function showClassIdeasPopup() {
    if (!personDetail || !personDetailCard) return;

    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail">';
    html += '<h3>Class Ideas Board</h3>';
    html += '<p style="color:var(--color-text-light);margin-bottom:1rem;">Have an idea? Share it in the <a href="https://docs.google.com/spreadsheets/d/19hR1Am3yzX9YC4jsJ32we-hPxUQ1IwMduz6xvaszMEA/edit?gid=0#gid=0" target="_blank" style="color:var(--color-primary);">master spreadsheet</a> or Google Chat!</p>';

    var groups = Object.keys(CLASS_IDEAS);
    groups.forEach(function (group) {
      var ideas = CLASS_IDEAS[group];
      html += '<div style="margin-bottom:1.25rem;">';
      html += '<h4 style="margin-bottom:0.5rem;font-size:0.95rem;">' + group + '</h4>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
      ideas.forEach(function (idea) {
        html += '<span class="idea-chip">' + idea + '</span>';
      });
      html += '</div></div>';
    });

    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) {
      if (e.target === personDetail) closeDetail();
    });
  }

  // Wire up WiFi nav button
  var wifiNavBtn = document.getElementById('wifiNavBtn');
  if (wifiNavBtn) {
    wifiNavBtn.addEventListener('click', function () {
      if (!personDetail || !personDetailCard) return;
      var html = '<button class="detail-close" aria-label="Close">&times;</button>';
      html += '<div class="elective-detail" style="text-align:center;">';
      html += '<h3>WiFi</h3>';
      html += '<p style="font-size:0.85rem;color:var(--color-text-light);margin-bottom:1rem;">The network is hidden \u2014 select "Find other/new network" on your device. Adults only, except for specific needs like online classes.</p>';
      html += '<div style="display:flex;justify-content:center;gap:1.5rem;flex-wrap:wrap;margin:0.5rem 0;">';
      html += '<div><span style="color:var(--color-text-light);font-size:0.75rem;">Network</span><br><strong>ROOTS</strong></div>';
      html += '<div><span style="color:var(--color-text-light);font-size:0.75rem;">Password</span><br><strong style="font-family:monospace;">Educ@t3!</strong></div>';
      html += '<div><span style="color:var(--color-text-light);font-size:0.75rem;">Security</span><br><strong>WPA2/WPA3</strong></div>';
      html += '</div>';
      html += '</div>';
      personDetailCard.innerHTML = html;
      personDetail.style.display = 'flex';
      document.body.style.overflow = 'hidden';
      personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
      personDetail.addEventListener('click', function (e) {
        if (e.target === personDetail) closeDetail();
      });
    });
  }

  // Wire up Class Ideas button
  var classIdeasBtn = document.getElementById('classIdeasBtn');
  if (classIdeasBtn) {
    classIdeasBtn.addEventListener('click', function () {
      showClassIdeasPopup();
    });
  }

  // Render all coordination tabs
  function renderCoordinationTabs() {
    renderSessionTab();
    renderCleaningTab();
    renderVolunteersTab();
    renderEventsTab();
  }

  // Render tabs on load
  renderCoordinationTabs();

  // Render on load if already logged in
  if (sessionStorage.getItem(SESSION_KEY) === 'true') {
    renderMyFamily();
  }

  // ──────────────────────────────────────────────
  // 8. Google Sign-In (Members Portal)
  // ──────────────────────────────────────────────
  //
  // Set this to your Google Cloud OAuth Client ID to enable Google Sign-In.
  // Leave as empty string to use password-only auth.
  //
  var GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
  //
  // Optional: restrict to your Google Workspace domain
  var ALLOWED_DOMAIN = 'rootsandwingsindy.com';

  function initGoogleSignIn() {
    if (!GOOGLE_CLIENT_ID || typeof google === 'undefined' || !google.accounts) return false;
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleSignIn,
      auto_select: false
    });

    var googleBtn = document.getElementById('googleSignInBtn');
    if (googleBtn) {
      google.accounts.id.renderButton(googleBtn, {
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        shape: 'pill',
        width: 280
      });

    }
    return true;
  }

  // Try immediately if library already loaded, otherwise wait for onload callback
  if (!initGoogleSignIn()) {
    window.__initGSI = initGoogleSignIn;
  }

  function handleGoogleSignIn(response) {
    // Decode the JWT token (client-side only — not cryptographically verified)
    try {
      var payload = JSON.parse(atob(response.credential.split('.')[1]));
      var email = payload.email || '';
      var domain = email.split('@')[1] || '';

      // Check domain restriction if configured
      if (ALLOWED_DOMAIN && domain !== ALLOWED_DOMAIN) {
        var googleError = document.getElementById('googleError');
        if (googleError) googleError.style.display = 'block';
        return;
      }

      // Success — store session and credential for API auth
      sessionStorage.setItem(SESSION_KEY, 'true');
      sessionStorage.setItem('rw_user_name', payload.name || '');
      sessionStorage.setItem('rw_user_email', email);
      sessionStorage.setItem('rw_google_credential', response.credential);
      showDashboard();
    } catch (err) {
      console.error('Google Sign-In error:', err);
    }
  }

  // ──────────────────────────────────────────────
  // 9. PWA Install Prompt
  // ──────────────────────────────────────────────
  var deferredPrompt = null;
  var installSection = document.getElementById('install-prompt');
  var installBtn = document.getElementById('installBtn');
  var dismissBtn = document.getElementById('dismissInstall');

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (installSection && !localStorage.getItem('rw_install_dismissed')) {
      installSection.style.display = '';
    }
  });

  if (installBtn) {
    installBtn.addEventListener('click', function () {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function () {
          deferredPrompt = null;
          if (installSection) installSection.style.display = 'none';
        });
      }
    });
  }

  if (dismissBtn) {
    dismissBtn.addEventListener('click', function () {
      if (installSection) installSection.style.display = 'none';
      localStorage.setItem('rw_install_dismissed', 'true');
    });
  }

  // ──────────────────────────────────────────────
  // 10. Style Switcher
  // ──────────────────────────────────────────────
  var THEMES = [
    {
      id: 'fraunces',
      label: 'Style 1',
      font: 'Fraunces',
      logo: 'logo-mark.svg',
      watermark: 'logo-mark.png',
      brandText: 'ROOTS & WINGS',
      swatches: ['#6B5E7B', '#4E4360', '#D4915E', '#9B8AAE']
    },
    {
      id: 'playfair',
      label: 'Style 2',
      font: 'Playfair Display',
      logo: 'Image_20260404_230404_036.png',
      watermark: 'Image_20260404_230404_036.png',
      brandText: 'Roots & Wings',
      swatches: ['#2D6A3F', '#1E4F2E', '#D4712A', '#8DB43E']
    },
    {
      id: 'style3',
      label: 'Style 3',
      font: 'Cormorant Garamond',
      logo: 'logo-style3.png',
      watermark: 'logo-style3.png',
      brandText: 'ROOTS & WINGS',
      swatches: ['#6B4E71', '#4E3754', '#D4915E', '#B68CB5']
    }
  ];

  var THEME_KEY = 'rw_theme';

  function getThemeById(id) {
    for (var i = 0; i < THEMES.length; i++) {
      if (THEMES[i].id === id) return THEMES[i];
    }
    return null;
  }

  function applyTheme(themeId) {
    var theme = getThemeById(themeId);
    if (!theme) return;

    // Set data attribute (or remove for default playfair)
    if (themeId === 'playfair') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', themeId);
    }

    // Swap logos
    document.querySelectorAll('.nav-brand img, .login-card .hero-logo img').forEach(function (img) {
      img.setAttribute('src', theme.logo);
    });
    document.querySelectorAll('.hero-watermark img').forEach(function (img) {
      img.setAttribute('src', theme.watermark);
    });

    // Update favicon
    var favicon = document.querySelector('link[rel="icon"]');
    if (favicon) favicon.setAttribute('href', theme.logo);

    // Update brand text and logo display
    if (theme.useFullLogo) {
      // Full logo mode: hide text, use larger logo image that includes text
      document.querySelectorAll('.nav-brand-text, .login-brand-text').forEach(function(el) {
        el.style.display = 'none';
      });
      document.querySelectorAll('.nav-brand img').forEach(function(img) {
        img.style.height = '56px';
        img.style.width = 'auto';
      });
      document.querySelectorAll('.footer-brand .nav-brand-text').forEach(function(el) {
        el.style.display = 'none';
      });
    } else {
      var brandText = theme.brandText || 'ROOTS & WINGS';
      document.querySelectorAll('.nav-brand-text, .login-brand-text').forEach(function(el) {
        el.style.display = '';
        var span = el.querySelector('span');
        var spanHtml = span ? span.outerHTML : '<span>Indianapolis</span>';
        el.innerHTML = brandText + '\n          ' + spanHtml;
      });
      document.querySelectorAll('.nav-brand img').forEach(function(img) {
        img.style.height = '';
        img.style.width = '';
      });
      document.querySelectorAll('.footer-brand .nav-brand-text').forEach(function(el) {
        el.style.display = '';
        var span = el.querySelector('span');
        var spanHtml = span ? span.outerHTML : '<span>Indianapolis</span>';
        el.innerHTML = brandText + '\n            ' + spanHtml;
      });
    }

    // Update active state in panel
    document.querySelectorAll('.style-option').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-theme') === themeId);
    });

    // Save preference
    localStorage.setItem(THEME_KEY, themeId);
  }

  function buildSwitcher() {
    // Toggle button
    var toggle = document.createElement('button');
    toggle.className = 'style-switcher-toggle';
    toggle.setAttribute('aria-label', 'Toggle style switcher');
    toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';

    // Panel
    var panel = document.createElement('div');
    panel.className = 'style-switcher-panel';
    panel.innerHTML = '<h4>Choose a Style</h4>';

    THEMES.forEach(function (theme) {
      var btn = document.createElement('button');
      btn.className = 'style-option';
      btn.setAttribute('data-theme', theme.id);

      var swatchesHtml = '<div class="style-option-swatches">';
      theme.swatches.forEach(function (color) {
        swatchesHtml += '<span class="style-option-swatch" style="background:' + color + '"></span>';
      });
      swatchesHtml += '</div>';

      btn.innerHTML = swatchesHtml +
        '<div><span class="style-option-label">' + theme.label +
        '</span><span class="style-option-font">' + theme.font + '</span></div>';

      btn.addEventListener('click', function () {
        applyTheme(theme.id);
      });

      panel.appendChild(btn);
    });

    document.body.appendChild(panel);
    document.body.appendChild(toggle);

    toggle.addEventListener('click', function () {
      panel.classList.toggle('open');
    });

    // Close panel on outside click
    document.addEventListener('click', function (e) {
      if (!panel.contains(e.target) && !toggle.contains(e.target)) {
        panel.classList.remove('open');
      }
    });
  }

  // Apply saved theme immediately, then build the UI
  var savedTheme = localStorage.getItem(THEME_KEY) || 'playfair';
  applyTheme(savedTheme);
  buildSwitcher();

})();
