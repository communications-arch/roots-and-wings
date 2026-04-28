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
  // 5. Member Portal Authentication (Google Sign-In only)
  // ──────────────────────────────────────────────

  var loginSection = document.getElementById('loginSection');
  var dashboard = document.getElementById('dashboard');
  var logoutBtn = document.getElementById('logoutBtn');

  var SESSION_KEY = 'rw_member_auth';

  // ── Session expiration detection ──────────────────────────────────────
  // Google ID tokens expire after ~1 hour. When they do, every authed API
  // call returns 401, data silently stops refreshing, and things like the
  // "View As" dropdown render empty with no visible error. Intercept fetch
  // responses for same-origin /api/* calls and, on the first 401 of the
  // session, drop an actionable banner.
  var sessionExpiredHandled = false;
  (function () {
    if (!window.fetch || window._rwFetchWrapped) return;
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var isApi = url.indexOf('/api/') === 0 ||
        url.indexOf(location.origin + '/api/') === 0;
      return origFetch(input, init).then(function (res) {
        if (isApi && res.status === 401 && !sessionExpiredHandled &&
            localStorage.getItem(SESSION_KEY) === 'true') {
          sessionExpiredHandled = true;
          // Log what we think the session is so "session expired" bugs are
          // easier to diagnose from the browser console.
          console.error('Session 401 for', url, '— signed-in email:',
            localStorage.getItem('rw_user_email') || '(none)',
            'credential present:',
            !!localStorage.getItem('rw_google_credential'));
          try { showSessionExpiredBanner(); } catch (e) { console.error(e); }
        }
        return res;
      });
    };
    window._rwFetchWrapped = true;
  })();

  function showSessionExpiredBanner() {
    if (document.getElementById('rw-session-expired')) return;
    var el = document.createElement('div');
    el.id = 'rw-session-expired';
    el.setAttribute('role', 'alert');
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0',
      'z-index:10000',
      'background:#7a1f2b', 'color:#fff',
      'padding:0.75rem 1rem',
      'box-shadow:0 2px 8px rgba(0,0,0,0.2)',
      'display:flex', 'gap:0.75rem', 'align-items:center',
      'justify-content:center', 'flex-wrap:wrap',
      'font-family:inherit', 'font-size:0.95rem'
    ].join(';');
    el.innerHTML =
      '<span>Your session has expired. Sign in again to keep editing.</span>' +
      '<button id="rwSignInAgainBtn" style="background:#fff;color:#7a1f2b;border:none;padding:0.45rem 0.9rem;border-radius:4px;font-weight:600;cursor:pointer;">Sign in again</button>';
    document.body.appendChild(el);

    var btn = document.getElementById('rwSignInAgainBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        // Clear session + any potentially-stale cached data so a fresh
        // sign-in starts clean, then show the login screen.
        try {
          localStorage.removeItem(SESSION_KEY);
          localStorage.removeItem('rw_google_credential');
          localStorage.removeItem('rw_user_email');
          sessionStorage.removeItem(VIEW_AS_KEY);
        } catch (e) { /* ignore */ }
        el.remove();
        sessionExpiredHandled = false;
        if (typeof showLogin === 'function') showLogin();
        window.scrollTo(0, 0);
      });
    }
  }

  // ── Live Data Loading from Google Sheets ──
  var liveDataLoaded = false;
  var liveDataReady = false; // true once data has been applied

  var CACHE_KEY = 'rw_sheets_cache';
  var CACHE_PHOTOS_KEY = 'rw_photos_cache';
  var COMMS_EMAIL = 'communications@rootsandwingsindy.com';
  var VIEW_AS_KEY = 'rw_view_as_email';

  // Compute a whole-number age from a birth date string ('YYYY-MM-DD' or any
  // Date-parseable form). Returns 0 on empty/invalid input so downstream
  // "Age N" strings stay out of the UI when we don't know the birthday.
  function computeAge(birthDate) {
    if (!birthDate) return 0;
    var bd = new Date(birthDate);
    if (isNaN(bd.getTime())) return 0;
    var today = new Date();
    var age = today.getFullYear() - bd.getFullYear();
    var m = today.getMonth() - bd.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < bd.getDate())) age--;
    return age > 0 ? age : 0;
  }

  // Treat sentinel values like "None", "N/A", "-", "no" as empty so allergy
  // callouts don't trigger for kids whose parents filled the field with a
  // negative answer instead of leaving it blank.
  function normalizeAllergies(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    if (/^(none|no|n\/a|na|nope|\.|-+)\.?$/i.test(s)) return '';
    return s;
  }

  // Resolve a "First Last" name to the corresponding entry in allPeople.
  // Used by class/elective detail modals to surface pronouns and allergies.
  function lookupPerson(fullName) {
    if (!fullName || typeof allPeople === 'undefined' || !Array.isArray(allPeople)) return null;
    var parts = String(fullName).trim().split(/\s+/);
    if (parts.length === 0) return null;
    var first = parts[0];
    var last = parts.slice(1).join(' ');
    for (var i = 0; i < allPeople.length; i++) {
      var p = allPeople[i];
      if (p.name !== first) continue;
      if (!last) return p;
      if (p.lastName === last || p.family === last) return p;
    }
    return null;
  }

  // Return a small italic pronouns tag for inline use, or '' if none.
  function pronounTag(person) {
    if (!person || !person.pronouns) return '';
    return ' <span class="pronoun-inline">(' + escapeHtml(person.pronouns) + ')</span>';
  }

  // Given a list of display-name students, build a red-accent callout listing
  // every kid with real allergies (sentinel "None" values are already stripped
  // at ingestion by normalizeAllergies). Returns '' if no one has allergies.
  function studentAllergyCallout(studentNames) {
    var callouts = [];
    (studentNames || []).forEach(function (name) {
      var p = lookupPerson(name);
      if (p && p.allergies) callouts.push({ name: name, allergies: p.allergies });
    });
    if (callouts.length === 0) return '';
    var html = '<div class="class-allergy-alerts"><div class="class-allergy-title">\u26A0 Allergy & Medical Alerts</div><ul>';
    callouts.forEach(function (c) {
      html += '<li><strong>' + escapeHtml(c.name) + ':</strong> ' + escapeHtml(c.allergies) + '</li>';
    });
    html += '</ul></div>';
    return html;
  }

  // Small HTML escape used by the helpers above. The bigger codebase uses
  // ad-hoc escapes; keeping this local and small avoids name collisions.
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getActiveEmail() {
    var viewAs = sessionStorage.getItem(VIEW_AS_KEY);
    if (viewAs) return viewAs;
    return localStorage.getItem('rw_user_email');
  }

  function isCommsUser() {
    return localStorage.getItem('rw_user_email') === COMMS_EMAIL;
  }

  // Header-level "View as" picker for the communications@ super user.
  // Lives in the sticky quick-shortcut bar so it stays visible no matter
  // which page (My Family, Workspace, etc.) is active. Backed by the same
  // VIEW_AS_KEY session slot as the (legacy) in-page picker so they stay
  // in sync.
  function renderHeaderViewAs() {
    var wrap = document.getElementById('qsbViewAs');
    var select = document.getElementById('qsbViewAsSelect');
    if (!wrap || !select) return;
    if (!isCommsUser() || !Array.isArray(FAMILIES) || FAMILIES.length === 0) {
      wrap.hidden = true;
      return;
    }
    var viewAsEmail = sessionStorage.getItem(VIEW_AS_KEY) || '';
    var html = '<option value="">\u2014 My Dashboard \u2014</option>';
    try {
      var sortedFams = FAMILIES.slice().sort(function (a, b) {
        return String(a && a.name || '').localeCompare(String(b && b.name || ''));
      });
      sortedFams.forEach(function (f) {
        if (!f || !f.email) return;
        // Phase 3: emit one option per login email so the comms super user can
        // impersonate a specific co-parent (e.g. Jay vs Jessica Shewan), not
        // just "the family". Each option's parent name is derived from the
        // login email (firstname+lastinitial convention) so a multi-login
        // family disambiguates cleanly.
        var emails = Array.isArray(f.loginEmails) && f.loginEmails.length > 0
          ? f.loginEmails
          : [f.email];
        // Use the DB-corrected family name when present (e.g. "O'Connor
        // Gading" instead of the sheet-parsed last word "Gading"). f.parents
        // is already overlay-corrected, so typo fixes flow through too.
        var familyDisplay = f.displayName || f.name || '';
        var parentsStr = f.parents || '';
        emails.forEach(function (em) {
          if (!em) return;
          var emLc = String(em).toLowerCase();
          var who = deriveFirstNameFromLogin(emLc, f.name);
          // Single-login families keep the legacy "(parents-string)" label
          // (e.g. "Shewan (Jessica & Jay)") so nothing changes for them.
          var label = (emails.length > 1 && who) ? (familyDisplay + ' (' + who + ')') : (familyDisplay + ' (' + parentsStr + ')');
          var selected = viewAsEmail === emLc ? ' selected' : '';
          html += '<option value="' + emLc + '"' + selected + '>' + label + '</option>';
        });
      });
    } catch (err) {
      // If a single bad family blows up the loop, log it and still render the
      // empty-state dropdown rather than hiding the picker entirely.
      console.error('[viewAs] picker build failed:', err);
    }
    select.innerHTML = html;
    wrap.hidden = false;
    if (!select._rwWired) {
      select.addEventListener('change', function () {
        if (this.value) sessionStorage.setItem(VIEW_AS_KEY, this.value);
        else sessionStorage.removeItem(VIEW_AS_KEY);
        if (typeof renderMyFamily === 'function') renderMyFamily();
        if (typeof renderCoordinationTabs === 'function') renderCoordinationTabs();
        if (typeof loadNotifications === 'function') loadNotifications();
        if (typeof renderWorkspaceTab === 'function') renderWorkspaceTab();
      });
      select._rwWired = true;
    }
  }

  // True when the active user (respecting View As) is the Vice President,
  // derived from the boardRole assigned in applySheetsData. Backend re-checks
  // via canEditAsRole against the volunteer sheet, so this only drives UI.
  function isVP() {
    var email = getActiveEmail();
    if (!email) return false;
    for (var i = 0; i < FAMILIES.length; i++) {
      // Board roles are person-scoped, not family-scoped. Use strict primary
      // family_email match so a co-parent doesn't inherit their spouse's role.
      if (String(FAMILIES[i].email || '').toLowerCase() === email.toLowerCase()
        && FAMILIES[i].boardRole === 'Vice President') return true;
    }
    return false;
  }

  // True when the active user (respecting View As) is the Treasurer. Same
  // pattern as isVP — drives client-side affordances; backend re-checks
  // via canEditAsRole against the volunteer sheet.
  function isTreasurer() {
    var email = getActiveEmail();
    if (!email) return false;
    for (var i = 0; i < FAMILIES.length; i++) {
      // Board roles are person-scoped, not family-scoped. Use strict primary
      // family_email match so a co-parent doesn't inherit their spouse's role.
      if (String(FAMILIES[i].email || '').toLowerCase() === email.toLowerCase()
        && FAMILIES[i].boardRole === 'Treasurer') return true;
    }
    return false;
  }

  function isMembershipDirector() {
    var email = getActiveEmail();
    if (!email) return false;
    for (var i = 0; i < FAMILIES.length; i++) {
      // Board roles are person-scoped, not family-scoped. Use strict primary
      // family_email match so a co-parent doesn't inherit their spouse's role.
      if (String(FAMILIES[i].email || '').toLowerCase() === email.toLowerCase()
        && FAMILIES[i].boardRole === 'Membership Director') return true;
    }
    return false;
  }

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
            // Index parentInfo by first name so we can thread photoConsent onto allPeople.
            var piByFirst = {};
            (fam.parentInfo || []).forEach(function (pi) {
              if (pi && pi.name) piByFirst[String(pi.name).trim().split(/\s+/)[0].toLowerCase()] = pi;
            });
            parentNames.forEach(function (pName) {
              if (!pName.trim()) return;
              var piHit = piByFirst[pName.trim().split(/\s+/)[0].toLowerCase()] || {};
              // Phase 3: derive each parent's own login email so downstream
              // lookups (getPhotoUrl, lookupPerson) resolve per-person rather
              // than collapsing both parents to fam.email (the primary).
              var pFirstLc = pName.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
              var pLastInit = String(fam.name || '').charAt(0).toLowerCase();
              // P4: prefer the explicit per-parent email/phone from parentInfo
              // (set via Edit My Info), then fall back to the firstname+
              // lastinitial derivation, then to fam.email as a last resort.
              // Phone falls back to the family-level phone for legacy rows.
              var pDerivedEmail = (pFirstLc && pLastInit)
                ? (pFirstLc + pLastInit + '@rootsandwingsindy.com')
                : (fam.email || '');
              var pEmail = piHit.email || pDerivedEmail;
              var pPhone = piHit.phone || fam.phone || '';
              // Per-parent first + last name. Each adult has their own first
              // and last. last_name falls back to fam.name in display via
              // person.lastName logic. When the DB hasn't been backfilled
              // yet, derive heuristically from pName (last word → last_name,
              // rest → first_name) so legacy data still renders sensibly.
              var pNameParts = pName.trim().split(/\s+/);
              var derivedFirst = pNameParts.length > 1 ? pNameParts.slice(0, -1).join(' ') : pNameParts[0];
              var derivedLast = pNameParts.length > 1 ? pNameParts[pNameParts.length - 1] : '';
              var personFirst = piHit.firstName || derivedFirst;
              var personLast = piHit.lastName || derivedLast;
              // Board role belongs to the specific parent who holds it — the
              // primary family_email holder — not every adult in the family.
              // A co-parent (Jay) shouldn't inherit their spouse's Treasurer
              // badge in the directory.
              var isPrimaryParent = pEmail.toLowerCase() === String(fam.email || '').toLowerCase();
              allPeople.push({
                name: personFirst,
                lastName: personLast,
                type: 'parent',
                family: fam.name,
                familyDisplay: fam.displayName || fam.name,
                email: pEmail,
                personalEmail: piHit.personalEmail || '',
                phone: pPhone,
                group: null,
                age: null,
                pronouns: pp[pName.trim()] || '',
                allergies: '',
                schedule: 'all-day',
                photoConsent: piHit.photoConsent !== false,
                parentNames: fam.parents,
                diffNameKids: diffNameKids,
                kidNames: (fam.kids || []).map(function(k) { return k.name + ' ' + (k.lastName || fam.name); }),
                boardRole: (isPrimaryParent && fam.boardRole) ? fam.boardRole : null,
                boardEmail: (isPrimaryParent && fam.boardRole) ? (fam.boardEmail || null) : null,
                role: piHit.role || null
              });
            });
            (fam.kids || []).forEach(function (kid) {
              allPeople.push({
                name: kid.name,
                lastName: kid.lastName || fam.name,
                type: 'kid',
                family: fam.name,
                familyDisplay: fam.displayName || fam.name,
                email: fam.email || '',
                phone: fam.phone || '',
                group: kid.group || '',
                age: kid.age || computeAge(kid.birthDate),
                birthDate: kid.birthDate || '',
                pronouns: kid.pronouns || '',
                allergies: normalizeAllergies(kid.allergies),
                schedule: kid.schedule || 'all-day',
                photoConsent: kid.photo_consent !== false,
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
            var incoming = data.pmSupportRoles[s];
            var existing = PM_SUPPORT_ROLES[s] || {};
            // Keep hardcoded board duty values when live data is empty
            if (incoming.boardDutiesPM2 && incoming.boardDutiesPM2.length === 0 && existing.boardDutiesPM2 && existing.boardDutiesPM2.length > 0) {
              incoming.boardDutiesPM2 = existing.boardDutiesPM2;
            }
            if (incoming.boardDutiesPM1 && incoming.boardDutiesPM1.length === 0 && existing.boardDutiesPM1 && existing.boardDutiesPM1.length > 0) {
              incoming.boardDutiesPM1 = existing.boardDutiesPM1;
            }
            // Handle old flat boardDuties field from cached API responses
            if (incoming.boardDuties && !incoming.boardDutiesPM1) {
              incoming.boardDutiesPM1 = incoming.boardDuties;
              if (!incoming.boardDutiesPM2) incoming.boardDutiesPM2 = existing.boardDutiesPM2 || [];
              delete incoming.boardDuties;
            }
            PM_SUPPORT_ROLES[s] = incoming;
          }
        }

        // ── Cleaning Crew ──
        if (data.cleaningCrew) {
          // DB liaison is authoritative if loaded; otherwise use sheets
          if (!cleaningDB.loaded) {
            CLEANING_CREW.liaison = data.cleaningCrew.liaison;
          }
          // For sessions: use sheets data for any session the DB doesn't have assignments for
          if (data.cleaningCrew.sessions) {
            for (var cs in data.cleaningCrew.sessions) {
              var dbHasSession = cleaningDB.assignments && cleaningDB.assignments.some(function (a) { return a.session_number === parseInt(cs); });
              if (!dbHasSession) {
                CLEANING_CREW.sessions[cs] = data.cleaningCrew.sessions[cs];
              }
            }
          }
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
    // Header-level View As picker depends on FAMILIES.
    if (typeof renderHeaderViewAs === 'function') renderHeaderViewAs();
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
    var googleCred = localStorage.getItem('rw_google_credential');
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
        // Pull live billing status (per-family Paid/Pending + semester rates).
        loadBillingStatus(function () {
          if (typeof renderMyFamily === 'function') renderMyFamily();
        });
      })
      .catch(function (err) {
        console.warn('Failed to load live data, using cached/static data:', err);
      });
  }

  // ── Role Descriptions DB state ──
  var CACHE_ROLES_KEY = 'rw_roles_cache';
  var roleDescriptions = []; // array of {id, role_key, title, ...}
  var roleDescriptionsLoaded = false;

  // Map duty text patterns to role_keys
  var DUTY_TO_ROLE_KEY = {
    'President': 'president',
    'Vice President': 'vice_president',
    'Vice-President': 'vice_president',
    'Treasurer': 'treasurer',
    'Secretary': 'secretary',
    'Membership Director': 'membership_director',
    'Sustaining Director': 'sustaining_director',
    'Communications Director': 'communications_director',
    'Cleaning Crew Liaison': 'cleaning_crew_liaison',
    'Supply Coordinator': 'supply_coordinator',
    'Supply Closet': 'supply_coordinator',
    'Safety Coordinator': 'safety_coordinator',
    'Opener & Morning Set-Up': 'opener',
    'Building Opener': 'opener',
    'Closer/Lost & Found': 'building_closer',
    'Building Closer': 'building_closer',
    'Afternoon Class Liaison': 'afternoon_class_liaison',
    'Morning Class Liaisons': 'morning_class_liaison',
    'Morning Class Liaison': 'morning_class_liaison',
    'Fundraising Coordinator': 'fundraising_coordinator',
    'Field Trip Coordinators': 'field_trip_coordinator',
    'Field Trip Coordinator': 'field_trip_coordinator',
    'Welcome Coordinator': 'welcome_coordinator',
    'Public Communications': 'public_communications',
    'Yearbook Coordinator': 'yearbook_coordinator',
    'Summer Social Events': 'summer_social_events',
    'Parent Social Events': 'parent_social_events',
    'Special Events Liaison': 'special_events_liaison',
    'Gratitude/Encouragement': 'gratitude_encouragement',
    'Archives': 'archives',
    'Admin/Organization': 'admin_organization',
    'Classroom Instructor': 'classroom_instructor',
    'Classroom Assistant': 'classroom_assistant',
    'Floater': 'floater'
  };

  function getRoleKeyForDuty(dutyText) {
    if (!dutyText) return '';
    // Normalize abbreviations
    var normalized = dutyText.replace(/\bDir\.\s*$/i, 'Director').replace(/\bDir\.\s/i, 'Director ');
    // Direct match
    if (DUTY_TO_ROLE_KEY[normalized]) return DUTY_TO_ROLE_KEY[normalized];
    if (DUTY_TO_ROLE_KEY[dutyText]) return DUTY_TO_ROLE_KEY[dutyText];
    // Strip trailing parenthetical like "(Finance Committee)"
    var base = normalized.replace(/\s*\(.*\)\s*$/, '').trim();
    if (DUTY_TO_ROLE_KEY[base]) return DUTY_TO_ROLE_KEY[base];
    // Check if duty text contains a known role name
    for (var key in DUTY_TO_ROLE_KEY) {
      if (dutyText.indexOf(key) !== -1) return DUTY_TO_ROLE_KEY[key];
    }
    // Check for "Class Liaison" in group liaison duties
    if (dutyText.indexOf('Class Liaison') !== -1) return 'morning_class_liaison';
    // Check for Leading/Assisting patterns
    if (dutyText.indexOf('Leading') !== -1) return 'classroom_instructor';
    if (dutyText.indexOf('Assisting') !== -1) return 'classroom_assistant';
    return null;
  }

  function getRoleByKey(key) {
    for (var i = 0; i < roleDescriptions.length; i++) {
      if (roleDescriptions[i].role_key === key) return roleDescriptions[i];
    }
    return null;
  }

  function applyRoleDescriptions(data) {
    if (!data || !data.roles) return;
    roleDescriptions = data.roles;
    roleDescriptionsLoaded = true;
  }

  function loadRoleDescriptions() {
    // Apply cached data immediately
    try {
      var cached = localStorage.getItem(CACHE_ROLES_KEY);
      if (cached) applyRoleDescriptions(JSON.parse(cached));
    } catch (e) { /* ignore */ }

    var googleCred = localStorage.getItem('rw_google_credential');
    if (!googleCred) return;
    fetch('/api/cleaning?action=roles', { headers: { 'Authorization': 'Bearer ' + googleCred } })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) return;
        try { localStorage.setItem(CACHE_ROLES_KEY, JSON.stringify(data)); } catch (e) { /* quota */ }
        applyRoleDescriptions(data);
        // Re-render to add info icons if dashboard is visible
        if (dashboard && dashboard.classList.contains('visible')) {
          if (typeof renderMyFamily === 'function') renderMyFamily();
        }
      })
      .catch(function () { /* fall back to cached */ });
  }

  function renderRoleDescriptionSection(roleKey) {
    var role = getRoleByKey(roleKey);
    if (!role) return '';
    var h = '<div class="rd-section">';
    h += '<div class="rd-section-divider"></div>';
    h += '<h4 class="rd-section-title">Role Description</h4>';
    if (role.overview) h += '<p class="rd-overview">' + role.overview + '</p>';
    if (role.duties && role.duties.length) {
      h += '<ul class="rd-duties">';
      role.duties.forEach(function (d) { h += '<li>' + d + '</li>'; });
      h += '</ul>';
    }
    if (role.job_length) h += '<p style="font-size:0.8rem;color:var(--color-text-light);margin:0;">Term: ' + role.job_length + '</p>';
    if (role.last_reviewed_by) {
      h += '<p class="rd-footer">Last reviewed ' + (role.last_reviewed_date || '') + ' by ' + role.last_reviewed_by + '</p>';
    }
    h += '</div>';
    return h;
  }

  function showRoleDescriptionModal(roleKey, canEdit) {
    var role = getRoleByKey(roleKey);
    if (!role || !personDetail || !personDetailCard) return;
    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail rd-modal">';
    html += '<div class="rd-view" id="rdView">';
    html += '<h3 class="rd-title">' + escapeHtml(role.title) + '</h3>';
    html += '<div class="rd-meta">';
    html += '<span class="rd-pill">' + escapeHtml(role.committee || '') + '</span>';
    html += '<span class="rd-pill">' + escapeHtml(role.job_length || '') + '</span>';
    html += '</div>';
    if (role.overview) {
      html += '<p class="rd-overview">' + escapeHtml(role.overview) + '</p>';
    }
    if (role.duties && role.duties.length > 0) {
      html += '<h4 class="rd-section-title">Responsibilities</h4>';
      html += '<ul class="rd-duties">';
      role.duties.forEach(function (d) {
        html += '<li>' + escapeHtml(d) + '</li>';
      });
      html += '</ul>';
    }
    // "Last reviewed by [name] on [date]" supersedes the older
    // "Last updated by [email] on [date]" — same information, friendlier
    // formatting, and stamped server-side from the JWT now.
    if (role.last_reviewed_by || role.last_reviewed_date) {
      html += '<p class="rd-footer">Last reviewed';
      if (role.last_reviewed_by) html += ' by ' + escapeHtml(role.last_reviewed_by);
      if (role.last_reviewed_date) html += ' on ' + escapeHtml(role.last_reviewed_date);
      html += '</p>';
    }
    if (canEdit) {
      html += '<button class="mf-manage-btn rd-edit-btn" id="rdEditBtn" style="margin-top:12px;">';
      html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
      html += ' Edit</button>';
    }
    html += '</div>';

    // Edit form (hidden initially)
    html += '<div class="rd-edit" id="rdEdit" style="display:none;">';
    html += '<h3 class="rd-title">Edit: ' + escapeHtml(role.title) + '</h3>';
    html += '<label class="rd-label">Overview</label>';
    html += '<textarea class="rd-textarea" id="rdEditOverview" rows="3">' + escapeHtml(role.overview || '') + '</textarea>';
    html += '<label class="rd-label">Job Length</label>';
    html += '<input class="rd-input" id="rdEditJobLength" value="' + escapeHtml(role.job_length || '') + '">';
    html += '<label class="rd-label">Responsibilities (one per line)</label>';
    html += '<textarea class="rd-textarea" id="rdEditDuties" rows="10">' + (role.duties || []).map(escapeHtml).join('\n') + '</textarea>';
    html += '<p class="rd-hint" style="font-size:0.85rem;color:#666;margin:8px 0 0;">"Last reviewed by" and date are stamped automatically when you save.</p>';
    html += '<div class="rd-btn-row">';
    html += '<button class="btn rd-save-btn" id="rdSaveBtn">Save</button>';
    html += '<button class="btn rd-cancel-btn" id="rdCancelBtn">Cancel</button>';
    html += '</div>';
    html += '</div>';

    html += '</div>';

    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) {
      if (e.target === personDetail) closeDetail();
    });

    if (canEdit) {
      var editBtn = personDetailCard.querySelector('#rdEditBtn');
      if (editBtn) {
        editBtn.addEventListener('click', function () {
          personDetailCard.querySelector('#rdView').style.display = 'none';
          personDetailCard.querySelector('#rdEdit').style.display = '';
        });
      }
      var cancelBtn = personDetailCard.querySelector('#rdCancelBtn');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', function () {
          personDetailCard.querySelector('#rdEdit').style.display = 'none';
          personDetailCard.querySelector('#rdView').style.display = '';
        });
      }
      var saveBtn = personDetailCard.querySelector('#rdSaveBtn');
      if (saveBtn) {
        saveBtn.addEventListener('click', function () {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving...';
          var newOverview = personDetailCard.querySelector('#rdEditOverview').value;
          var newJobLength = personDetailCard.querySelector('#rdEditJobLength').value;
          var newDuties = personDetailCard.querySelector('#rdEditDuties').value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
          var googleCred = localStorage.getItem('rw_google_credential');
          fetch('/api/cleaning?action=roles&id=' + role.id, {
            method: 'PATCH',
            headers: { 'Authorization': 'Bearer ' + googleCred, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              overview: newOverview,
              job_length: newJobLength,
              duties: newDuties
            })
          })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.ok) {
              role.overview = newOverview;
              role.job_length = newJobLength;
              role.duties = newDuties;
              // Server stamps and returns the review fields — trust those.
              if (data.last_reviewed_by) role.last_reviewed_by = data.last_reviewed_by;
              if (data.last_reviewed_date) role.last_reviewed_date = data.last_reviewed_date;
              role.updated_at = new Date().toISOString();
              role.updated_by = (typeof getActiveEmail === 'function' && getActiveEmail()) || role.updated_by || '';
              try { localStorage.setItem(CACHE_ROLES_KEY, JSON.stringify({ roles: roleDescriptions })); } catch (e) { /* quota */ }
              closeDetail();
              showRoleDescriptionModal(roleKey, canEdit);
              if (typeof renderWorkspaceTab === 'function') {
                try { renderWorkspaceTab(); } catch (e) { /* workspace tab not rendered — fine */ }
              }
            } else {
              saveBtn.disabled = false;
              saveBtn.textContent = 'Save';
              alert('Save failed: ' + (data.error || 'Unknown error'));
            }
          })
          .catch(function () {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
            alert('Save failed. Please try again.');
          });
        });
      }
    }
  }

  // Dedicated Playbook & Handoff Notes modal with a view ↔ edit toggle.
  // Persists via the same /api/cleaning?action=roles endpoint that the
  // full role-description modal uses, but only touches the playbook
  // column — overview/duties/etc. are unaffected.
  function showRolePlaybookModal(roleKey, canEdit) {
    var role = getRoleByKey(roleKey);
    if (!role || !personDetail || !personDetailCard) return;

    function renderPlaybookBody() {
      if (!role.playbook) {
        return '<p class="ws-empty">No playbook yet. ' + (canEdit ? 'Click Edit to add the first notes.' : '') + '</p>';
      }
      return '<div class="rd-playbook">' + renderPlaybookHtml(role.playbook) + '</div>';
    }

    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail rd-modal">';

    // View mode
    html += '<div class="rd-view" id="rpbView">';
    html += '<h3 class="rd-title">' + escapeHtml(role.title) + '</h3>';
    html += '<p class="rd-subtitle">Playbook &amp; Handoff Notes</p>';
    html += '<div id="rpbViewBody">' + renderPlaybookBody() + '</div>';
    if (canEdit) {
      html += '<button class="btn btn-sm btn-outline-dark" id="rpbEditBtn" style="margin-top:12px;">';
      html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
      html += ' Edit</button>';
    }
    html += '</div>';

    // Edit mode (hidden initially)
    if (canEdit) {
      html += '<div class="rd-edit" id="rpbEdit" style="display:none;">';
      html += '<h3 class="rd-title">Edit Playbook</h3>';
      html += '<p class="rd-hint">Long-form guide for whoever holds this role. Timelines, instructions, troubleshooting, links\u2014anything the next person will need.</p>';
      html += '<div class="rd-playbook-editor-wrap"><div id="rpbQuill"></div></div>';
      html += '<div class="rd-btn-row">';
      html += '<button class="btn rd-save-btn" id="rpbSaveBtn">Save</button>';
      html += '<button class="btn rd-cancel-btn" id="rpbCancelBtn">Cancel</button>';
      html += '</div>';
      html += '</div>';
    }

    html += '</div>';

    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) {
      if (e.target === personDetail) closeDetail();
    });

    if (!canEdit) return;

    var viewEl = personDetailCard.querySelector('#rpbView');
    var editEl = personDetailCard.querySelector('#rpbEdit');
    var viewBodyEl = personDetailCard.querySelector('#rpbViewBody');
    var quillInstance = null;

    function initQuill() {
      if (quillInstance || typeof Quill === 'undefined') return;
      var quillEl = personDetailCard.querySelector('#rpbQuill');
      if (!quillEl) return;
      quillInstance = new Quill(quillEl, {
        theme: 'snow',
        placeholder: 'Timelines, instructions, troubleshooting, links\u2026',
        modules: {
          toolbar: [
            [{ header: [2, 3, false] }],
            ['bold', 'italic', 'underline'],
            [{ list: 'ordered' }, { list: 'bullet' }],
            ['link', 'blockquote'],
            ['clean']
          ]
        }
      });
      var existing = role.playbook || '';
      var seedHtml = existing;
      if (existing && !/<[a-z][\s\S]*>/i.test(existing)) {
        seedHtml = escapeHtml(existing).replace(/\n/g, '<br>');
      }
      if (seedHtml) quillInstance.clipboard.dangerouslyPasteHTML(seedHtml);
    }

    personDetailCard.querySelector('#rpbEditBtn').addEventListener('click', function () {
      viewEl.style.display = 'none';
      editEl.style.display = '';
      initQuill();
    });

    personDetailCard.querySelector('#rpbCancelBtn').addEventListener('click', function () {
      editEl.style.display = 'none';
      viewEl.style.display = '';
    });

    personDetailCard.querySelector('#rpbSaveBtn').addEventListener('click', function () {
      var saveBtn = this;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      var newPlaybook = '';
      if (quillInstance) {
        var raw = quillInstance.root.innerHTML;
        newPlaybook = (raw === '<p><br></p>') ? '' : raw;
      }
      var googleCred = localStorage.getItem('rw_google_credential');
      fetch('/api/cleaning?action=roles&id=' + role.id, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + googleCred, 'Content-Type': 'application/json' },
        body: JSON.stringify({ playbook: newPlaybook })
      })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.ok) {
          role.playbook = newPlaybook;
          role.updated_at = new Date().toISOString();
          role.updated_by = (typeof getActiveEmail === 'function' && getActiveEmail()) || role.updated_by || '';
          try { localStorage.setItem(CACHE_ROLES_KEY, JSON.stringify({ roles: roleDescriptions })); } catch (e) { /* quota */ }
          // Swap view body content + flip back to view mode without closing.
          viewBodyEl.innerHTML = renderPlaybookBody();
          editEl.style.display = 'none';
          viewEl.style.display = '';
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
          if (typeof renderWorkspaceTab === 'function') {
            try { renderWorkspaceTab(); } catch (e) { /* workspace tab not rendered — fine */ }
          }
        } else {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
          alert('Save failed: ' + (data.error || 'Unknown error'));
        }
      })
      .catch(function () {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        alert('Save failed. Please try again.');
      });
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Render the playbook for display. New content saved by Quill is HTML; legacy
  // content is plain text. If we detect HTML tags, sanitize with an allow-list
  // (strip <script>/<style>/<iframe>, drop on* handlers, force external links
  // to open safely). Otherwise fall back to escape + newline + autolink.
  var PLAYBOOK_ALLOWED_TAGS = {
    P:1, BR:1, STRONG:1, B:1, EM:1, I:1, U:1, A:1,
    UL:1, OL:1, LI:1, H2:1, H3:1, H4:1, BLOCKQUOTE:1,
    SPAN:1, DIV:1
  };
  function sanitizePlaybookHtml(html) {
    var doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = html;
    (function walk(node) {
      var child = node.firstChild;
      while (child) {
        var next = child.nextSibling;
        if (child.nodeType === 1) {
          if (!PLAYBOOK_ALLOWED_TAGS[child.tagName]) {
            // Replace disallowed element with its text content
            var text = doc.createTextNode(child.textContent || '');
            node.replaceChild(text, child);
          } else {
            // Strip every attribute except safe ones on <a>
            var attrs = Array.prototype.slice.call(child.attributes);
            for (var i = 0; i < attrs.length; i++) {
              var a = attrs[i];
              var keep = false;
              if (child.tagName === 'A' && (a.name === 'href' || a.name === 'title')) {
                var href = (a.value || '').trim();
                if (/^(https?:|mailto:|tel:|#|\/)/i.test(href)) keep = true;
              }
              if (!keep) child.removeAttribute(a.name);
            }
            if (child.tagName === 'A') {
              child.setAttribute('target', '_blank');
              child.setAttribute('rel', 'noopener noreferrer');
            }
            walk(child);
          }
        }
        child = next;
      }
    })(doc.body);
    return doc.body.innerHTML;
  }
  function renderPlaybookHtml(text) {
    if (!text) return '';
    if (/<[a-z][\s\S]*>/i.test(text)) {
      return sanitizePlaybookHtml(text);
    }
    var escaped = escapeHtml(text);
    return escaped.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
      var trailing = '';
      while (/[).,;!?]$/.test(url)) {
        trailing = url.slice(-1) + trailing;
        url = url.slice(0, -1);
      }
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>' + trailing;
    });
  }

  function formatUpdatedAt(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }

  // ── Cleaning Crew DB state ──
  var CACHE_CLEANING_KEY = 'rw_cleaning_cache';
  var cleaningDB = { areas: [], assignments: [], loaded: false, editMode: false };

  function applyCleaningData(data) {
    if (!data || data.error) return;
    cleaningDB.areas = data.areas || [];
    cleaningDB.assignments = data.assignments || [];
    cleaningDB.loaded = true;
    if (data.liaison) CLEANING_CREW.liaison = data.liaison;
    if (data.sessions) {
      for (var s in data.sessions) {
        CLEANING_CREW.sessions[s] = data.sessions[s];
      }
    }
  }

  function loadCleaningData() {
    // Apply cached data immediately for instant load
    try {
      var cached = localStorage.getItem(CACHE_CLEANING_KEY);
      if (cached) applyCleaningData(JSON.parse(cached));
    } catch (e) { /* ignore */ }

    var googleCred = localStorage.getItem('rw_google_credential');
    if (!googleCred) return;
    fetch('/api/cleaning', { headers: { 'Authorization': 'Bearer ' + googleCred } })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) return;
        try { localStorage.setItem(CACHE_CLEANING_KEY, JSON.stringify(data)); } catch (e) { /* quota */ }
        applyCleaningData(data);
        if (typeof renderCleaningTab === 'function') renderCleaningTab();
        if (typeof renderMyFamily === 'function') renderMyFamily();
      })
      .catch(function () { /* fall back to cached/hardcoded */ });
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
    var googleCred = localStorage.getItem('rw_google_credential');
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

  // Google Calendar event colorId → hex. Matches the palette in Google
  // Calendar's "Event color" picker. colorId is a string "1"-"11" as
  // returned by the Calendar API. Sage is the co-op's default (most
  // regular co-op days have no explicit colorId set).
  var GCAL_EVENT_COLORS = {
    '1':  '#7986CB', // Lavender
    '2':  '#33B679', // Sage
    '3':  '#8E24AA', // Grape
    '4':  '#E67C73', // Flamingo
    '5':  '#F6BF26', // Banana
    '6':  '#F4511E', // Tangerine
    '7':  '#039BE5', // Peacock
    '8':  '#616161', // Graphite
    '9':  '#3F51B5', // Blueberry
    '10': '#0B8043', // Basil
    '11': '#D50000'  // Tomato
  };
  var GCAL_DEFAULT_COLOR = '#33B679'; // Sage — regular co-op days

  // Per-calendar fallback colors. Used when an event has no colorId set
  // (which is the common case — event-level colors in Google Calendar are
  // rarely used, but shared calendars each have a default background color
  // that the app is expected to reflect).
  var GCAL_SOURCE_COLORS = {
    // Main R&W co-op calendar (regular Wednesdays, etc.)
    'c_fdc0b20caba65262b9aac95ac1df638ab892fcdf1ee1ad79a1880dcc2a95b291@group.calendar.google.com': '#33B679', // Sage
    // R&W Special Events (Field Day, Talent Show, etc.)
    'c_f7e599c566fa32ba8da0c20bf51c82967e9d8aedffa8f775673db5146646b1b2@group.calendar.google.com': '#D81B60'  // Raspberry
  };

  // Title-keyword rules. Evaluated in order; first match wins. Used when
  // Google's per-event colorId isn't set (it often isn't — event-level
  // color overrides don't reliably round-trip through the API to service
  // accounts). Keep a single Members calendar and drive colors from naming.
  var GCAL_TITLE_RULES = [
    { match: /deadline/i,       color: '#D50000' }, // Tomato — Deadlines
    { match: /field trip/i,     color: '#3F51B5' }, // Blueberry — Field Trips
    { match: /special event/i,  color: '#8E24AA' }, // Grape — Special Events
    { match: /member meeting/i, color: '#F4511E' }  // Tangerine — Member Meetings
  ];

  function matchTitleColor(summary) {
    if (!summary) return null;
    for (var i = 0; i < GCAL_TITLE_RULES.length; i++) {
      if (GCAL_TITLE_RULES[i].match.test(summary)) return GCAL_TITLE_RULES[i].color;
    }
    return null;
  }

  function renderCalendar(events) {
    var el = document.getElementById('calendarEvents');
    if (!el || !events) return;

    if (events.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:var(--color-text-light);padding:40px 0;">No upcoming events.</div>';
      return;
    }

    try {
      console.log('[R&W calendar] diag:', events.map(function (e) {
        return { summary: e.summary, colorId: e.colorId || '(none)', src: (e.sourceCalendarId || '').slice(0, 14) };
      }));
    } catch (e) { /* ignore */ }

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

      var color = GCAL_EVENT_COLORS[ev.colorId]
        || matchTitleColor(ev.summary)
        || GCAL_SOURCE_COLORS[ev.sourceCalendarId]
        || GCAL_DEFAULT_COLOR;
      html += '<div class="cal-event" style="border-left:4px solid ' + color + ';padding-left:12px;">';
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

    var googleCred = localStorage.getItem('rw_google_credential');
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

  // True iff the given email matches the family's primary OR any co-parent
  // login. Phase 3: replaces the old direct fam.email comparison so a
  // co-parent's secondary login (e.g. jays@ for the Shewan family) resolves
  // to the right family object.
  function familyMatchesEmail(fam, emailLower) {
    if (!fam || !emailLower) return false;
    var loginEmails = Array.isArray(fam.loginEmails) ? fam.loginEmails : null;
    if (loginEmails && loginEmails.length > 0) {
      for (var i = 0; i < loginEmails.length; i++) {
        if (String(loginEmails[i] || '').toLowerCase() === emailLower) return true;
      }
      return false;
    }
    return String(fam.email || '').toLowerCase() === emailLower;
  }

  // Best-effort first name for the active user, given their login email and
  // their family's last name. Follows the firstname+lastinitial convention
  // used to derive Workspace emails — strips the trailing initial off the
  // local part. Returns null if it can't infer; callers should fall back to
  // the family's primary parent string. Phase 3: lets the greeting and avatar
  // lookups address the actual signed-in co-parent (e.g. Jay) rather than
  // always defaulting to the family's first parent (Jessica).
  function deriveFirstNameFromLogin(email, familyName) {
    if (!email || !familyName) return null;
    var local = String(email).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
    var initial = String(familyName).charAt(0).toLowerCase();
    if (!local || !initial) return null;
    var stem = local.endsWith(initial) ? local.slice(0, -1) : local;
    if (!stem) return null;
    return stem.charAt(0).toUpperCase() + stem.slice(1);
  }

  // DB-only photo lookup — used for kids, who don't have Workspace accounts
  // and whose family email would resolve to the parent's photo via the
  // memberPhotos map if we fell through.
  function getDbPhotoForPerson(personName, email, familyName) {
    if (typeof FAMILIES === 'undefined' || !Array.isArray(FAMILIES) || !personName) return null;
    var firstNameLower = String(personName).trim().split(/\s+/)[0].toLowerCase();
    var matchFam = null;
    if (email) {
      var emailLower = String(email).toLowerCase();
      for (var fi = 0; fi < FAMILIES.length; fi++) {
        if (familyMatchesEmail(FAMILIES[fi], emailLower)) { matchFam = FAMILIES[fi]; break; }
      }
    }
    if (!matchFam && familyName) {
      var famLower = String(familyName).toLowerCase();
      for (var fj = 0; fj < FAMILIES.length; fj++) {
        if (String(FAMILIES[fj].name || '').toLowerCase() === famLower) { matchFam = FAMILIES[fj]; break; }
      }
    }
    if (!matchFam) return null;
    var pInfo = matchFam.parentInfo || [];
    for (var pk = 0; pk < pInfo.length; pk++) {
      if (pInfo[pk].photoUrl && String(pInfo[pk].name || '').trim().split(/\s+/)[0].toLowerCase() === firstNameLower) {
        return pInfo[pk].photoUrl;
      }
    }
    var famKids = matchFam.kids || [];
    for (var kk = 0; kk < famKids.length; kk++) {
      if (String(famKids[kk].name || '').trim().split(/\s+/)[0].toLowerCase() !== firstNameLower) continue;
      // Per-child photo opt-out honored here so callers don't need to double-check.
      if (famKids[kk].photo_consent === false) return null;
      if (famKids[kk].photoUrl) return famKids[kk].photoUrl;
    }
    return null;
  }

  function getPhotoUrl(personName, email, familyName) {
    if (!email && !familyName && !personName) return null;
    // DB-sourced photo (set via Edit My Info -> Vercel Blob) wins over Workspace
    // photos. Overlay from /api/sheets lands on fam.parentInfo[].photoUrl and
    // fam.kids[].photoUrl.
    if (typeof FAMILIES !== 'undefined' && Array.isArray(FAMILIES) && personName) {
      var firstNameLower = String(personName).trim().split(/\s+/)[0].toLowerCase();
      var matchFam = null;
      if (email) {
        var emailLower = String(email).toLowerCase();
        for (var fi = 0; fi < FAMILIES.length; fi++) {
          if (familyMatchesEmail(FAMILIES[fi], emailLower)) { matchFam = FAMILIES[fi]; break; }
        }
      }
      if (!matchFam && familyName) {
        var famLower = String(familyName).toLowerCase();
        for (var fj = 0; fj < FAMILIES.length; fj++) {
          if (String(FAMILIES[fj].name || '').toLowerCase() === famLower) { matchFam = FAMILIES[fj]; break; }
        }
      }
      if (matchFam) {
        var pInfo = matchFam.parentInfo || [];
        // Adult consent gate: if any parentInfo entry for this first name is
        // opted out, return null before we fall through to Workspace photos.
        for (var pc = 0; pc < pInfo.length; pc++) {
          if (String(pInfo[pc].name || '').trim().split(/\s+/)[0].toLowerCase() === firstNameLower) {
            if (pInfo[pc].photoConsent === false) return null;
            break;
          }
        }
        for (var pk = 0; pk < pInfo.length; pk++) {
          if (pInfo[pk].photoUrl && String(pInfo[pk].name || '').trim().split(/\s+/)[0].toLowerCase() === firstNameLower) {
            return pInfo[pk].photoUrl;
          }
        }
        var famKids = matchFam.kids || [];
        for (var kk = 0; kk < famKids.length; kk++) {
          if (String(famKids[kk].name || '').trim().split(/\s+/)[0].toLowerCase() !== firstNameLower) continue;
          // Per-child photo opt-out honored here so callers don't need to double-check.
          if (famKids[kk].photo_consent === false) return null;
          if (famKids[kk].photoUrl) return famKids[kk].photoUrl;
        }
      }
    }
    // Try matching by firstname + last initial first (e.g. "erinb" for "Erin Bogan")
    // This prioritizes personal accounts over role accounts (e.g. president@)
    if (personName && familyName) {
      var first = personName.trim().split(' ')[0].toLowerCase();
      var lastInitial = familyName.charAt(0).toLowerCase();
      var guess = first + lastInitial + '@rootsandwingsindy.com';
      if (memberPhotos[guess]) return memberPhotos[guess];
    }
    // Try direct email match — but only if the email is plausibly THIS person's,
    // not a co-parent's. Phase 3: allPeople sets each parent's email to the
    // family's primary family_email, which means a co-parent (Jay) would fall
    // back to the primary parent's (Jessica's) photo here. Gate by checking
    // that the email's local part starts with the person's first name; that
    // includes the firstname+lastinitial convention plus role-email aliases
    // like "president@" (no person name = no gate, keeps board-photo flow).
    if (email) {
      var emailLc = email.toLowerCase();
      var coherent = true;
      if (personName) {
        var firstLc = personName.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
        var localLc = emailLc.split('@')[0].replace(/[^a-z]/g, '');
        coherent = firstLc && localLc.indexOf(firstLc) === 0;
      }
      if (coherent) {
        var url = memberPhotos[email] || memberPhotos[emailLc];
        if (url) return url;
      }
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

  // Kids don't have Workspace accounts — using getPhotoUrl would fall through
  // to the parent's photo via the family email. getDbPhotoForPerson is the
  // correct path for EMI-uploaded kid photos (set on fam.kids[].photoUrl).
  function kidAvatarInnerHtml(kidName, email, familyName) {
    var url = getDbPhotoForPerson(kidName, email, familyName);
    if (url) {
      var hi = url.replace(/=s\d+-c/, '=s256-c');
      return '<img src="' + hi + '" alt="' + kidName + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'\'">' +
        '<span style="display:none">' + kidName.charAt(0) + '</span>';
    }
    return '<span>' + kidName.charAt(0) + '</span>';
  }

  // Temporary debug hook so we can inspect state from the browser console.
  // Exposes the in-IIFE objects without altering behavior. Safe to leave in
  // for now — there's nothing sensitive that isn't already rendered in the UI.
  window.__rwDebug = {
    getFamilies: function () { return FAMILIES; },
    getAllPeople: function () { return allPeople; },
    getMemberPhotos: function () { return memberPhotos; },
    getDbPhotoForPerson: function (n, e, f) { return getDbPhotoForPerson(n, e, f); },
    getPhotoUrl: function (n, e, f) { return getPhotoUrl(n, e, f); },
    applyPhotos: function () { return applyPhotos(); }
  };

  function applyPhotos() {
    // Find all yb-cards and update photos by matching family email
    if (!allPeople || allPeople.length === 0) return;
    var cards = document.querySelectorAll('.yb-card');
    var dbg = [];
    cards.forEach(function(card) {
      var idx = parseInt(card.getAttribute('data-idx'));
      var person = allPeople[idx];
      if (!person) return;
      var photoDiv = card.querySelector('.yb-photo');
      if (!photoDiv) return;
      // Per-person photo opt-out: never render a photo for anyone (adult or
      // kid) whose consent is explicitly false. The initial-on-color
      // placeholder already in the card stays as the fallback.
      if (person.photoConsent === false) return;
      var url;
      if (person.type === 'kid') {
        // Kids don't have Workspace photos; only apply a DB-sourced photo
        // (uploaded via Edit My Info). Skip Workspace fallback entirely.
        url = getDbPhotoForPerson(person.name, person.email, person.family);
      } else {
        url = getPhotoUrl(person.name, person.email, person.family);
      }
      if (person.type === 'kid') {
        dbg.push({ name: person.name, family: person.family, email: person.email, url: url || '(none)', hasImg: !!photoDiv.querySelector('img') });
      }
      if (url && !photoDiv.querySelector('img')) {
        var hiRes = url.replace(/=s\d+-c/, '=s256-c');
        photoDiv.innerHTML = '<img src="' + hiRes + '" alt="' + person.name + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'\'"><span style="display:none">' + person.name.charAt(0) + '</span>';
      }
    });
    if (dbg.length) console.log('[rw-debug] applyPhotos kids:', dbg);

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
    loadCleaningData();
    loadRoleDescriptions();
    // Render with whatever data is available (live if preloaded, static otherwise)
    setTimeout(function () {
      if (typeof renderMyFamily === 'function') renderMyFamily();
      if (typeof initAbsenceCoverageSystem === 'function') initAbsenceCoverageSystem();
    }, 0);
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
    localStorage.removeItem(SESSION_KEY);
  }

  // Check for existing session. We only show the dashboard when the stored
  // Google credential is still valid (exp claim in the future). If the token
  // has expired but the user was previously signed in, initGoogleSignIn()
  // will call google.accounts.id.prompt() below to silently refresh it —
  // that flow fires handleGoogleSignIn → showDashboard automatically.
  if (loginSection && dashboard) {
    if (localStorage.getItem(SESSION_KEY) === 'true' && hasValidStoredCredential()) {
      showDashboard();
    }

    // Logout — clear *everything* that could keep a stale Google JWT
    // around, and ask Google Identity Services to drop its auto-select
    // cache so the next sign-in goes through a real credential exchange.
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        try {
          localStorage.removeItem(CACHE_KEY);
          localStorage.removeItem(CACHE_PHOTOS_KEY);
          localStorage.removeItem(CACHE_CLEANING_KEY);
          sessionStorage.removeItem(VIEW_AS_KEY);
          localStorage.removeItem('rw_google_credential');
          localStorage.removeItem('rw_user_email');
          localStorage.removeItem('rw_user_name');
        } catch (e) { /* ignore */ }
        if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
          try { google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ }
        }
        sessionExpiredHandled = false;
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

  // View switcher: nav-links and quick-shortcut-bar pills drive visibility of
  // the Workspace panel vs the Co-op Info scroll view. data-view="workspace"
  // reveals the Workspace; data-view="info" returns to the info scroll (and
  // lets the browser handle the anchor jump). Links without data-view
  // (Public Site, etc.) fall through to default behavior.
  function showViewMode(mode) {
    var ws = document.getElementById('page-workspace');
    var info = document.getElementById('page-info');
    if (ws) ws.style.display = mode === 'workspace' ? '' : 'none';
    if (info) info.style.display = mode === 'info' ? '' : 'none';
    document.querySelectorAll('[data-view]').forEach(function (el) {
      var isActive = el.getAttribute('data-view') === mode;
      el.classList.toggle('active', isActive);
    });
    if (mode === 'workspace' && typeof renderWorkspaceTab === 'function') renderWorkspaceTab();
  }
  document.querySelectorAll('[data-view]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      var mode = this.getAttribute('data-view');
      showViewMode(mode);
      // For info-view links, let the browser scroll to the anchor — don't
      // preventDefault. For Workspace, #page-workspace is the natural anchor
      // target so scrolling there is fine too.
      // Close the hamburger menu if it's open.
      var toggle = document.querySelector('.nav-toggle');
      var links = document.querySelector('.nav-links');
      if (toggle && links && links.classList.contains('open')) {
        links.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
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
  };

  // ── Afternoon electives (per session) ──
  var PM_ELECTIVES = {
  };

  // ── AM Support Roles (per session) ──
  var AM_SUPPORT_ROLES = {
  };

  var PM_SUPPORT_ROLES = {
  };

  // ── Cleaning crew assignments (structured by area) ──
  var CLEANING_CREW = {
    liaison: '',
    sessions: {}
  };

  // ── Volunteer committees (year-long) ──
  var VOLUNTEER_COMMITTEES = [
  ];

  // ── Special events ──
  var SPECIAL_EVENTS = [
  ];

  // ── Class Ideas Board ──
  var CLASS_IDEAS = {
  };

  // Family data — populated from Google Sheets API
  var FAMILIES = [
  ];

  // Build flat list of all people (parents + kids) for the yearbook
  var allPeople = [];
  FAMILIES.forEach(function (fam) {
    var parentNames = fam.parents.split(' & ');
    var pp = fam.parentPronouns || {};
    // Collect kids with different last names for parent display
    var diffNameKids = fam.kids.filter(function(k) { return k.lastName && k.lastName !== fam.name; });
    // Index parentInfo by first name so we can thread photoConsent onto allPeople.
    var piByFirst2 = {};
    (fam.parentInfo || []).forEach(function (pi) {
      if (pi && pi.name) piByFirst2[String(pi.name).trim().split(/\s+/)[0].toLowerCase()] = pi;
    });
    parentNames.forEach(function (pName) {
      var piHit2 = piByFirst2[pName.trim().split(/\s+/)[0].toLowerCase()] || {};
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
        photoConsent: piHit2.photoConsent !== false,
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
        age: kid.age || computeAge(kid.birthDate),
        birthDate: kid.birthDate || '',
        pronouns: kid.pronouns || '',
        allergies: normalizeAllergies(kid.allergies),
        schedule: kid.schedule || 'all-day',
        photoConsent: kid.photo_consent !== false,
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

  // Nearest upcoming co-op day — returns today's date if today is co-op day,
  // else the next one. Formatted YYYY-MM-DD.
  function getNextCoopDate() {
    var d = new Date();
    var daysUntil = (3 - d.getDay() + 7) % 7; // 0 if today IS Wednesday
    d.setDate(d.getDate() + daysUntil);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function renderDirectory() {
    if (!directoryGrid) return;
    var query = (directorySearch ? directorySearch.value : '').toLowerCase();
    var staff = AM_CLASSES[activeFilter];
    var isClassView = isGroupFilter(activeFilter) && !query;
    var html = '';
    var shown = 0;

    // Build the absence/coverage picture for the next co-op day so directory
    // cards can surface who's out and who's covering for that day.
    var coopDateIso = getNextCoopDate();
    var todayIso = new Date().toISOString().slice(0, 10);
    var coopLabel = coopDateIso === todayIso ? 'today' : formatDateLabel(coopDateIso).replace(/^\w+,\s*/, '');
    var outByName = {};      // "Amber Furnish" -> true
    var coveringByName = {}; // "Bobby Furnish" -> ["AM: Saplings Assistant", ...]
    (loadedAbsences || []).forEach(function (a) {
      if (String(a.absence_date || '').slice(0, 10) !== coopDateIso) return;
      if (a.absent_person) outByName[a.absent_person] = true;
      (a.slots || []).forEach(function (slot) {
        if (!slot.claimed_by_name) return;
        if (!coveringByName[slot.claimed_by_name]) coveringByName[slot.claimed_by_name] = [];
        coveringByName[slot.claimed_by_name].push(slot.role_description);
      });
    });

    function absenceTagFor(fullName) {
      if (outByName[fullName]) return '<div class="yb-absent-badge">Out ' + coopLabel + '</div>';
      var covs = coveringByName[fullName];
      if (covs && covs.length > 0) {
        var first = covs[0];
        var more = covs.length > 1 ? ' +' + (covs.length - 1) : '';
        return '<div class="yb-covering-badge">Covering: ' + first + more + '</div>';
      }
      return '';
    }

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

      // Class-wide allergy / medical alerts — mirrors the Class Pack callout
      // so teachers see these whether they're on-screen or printed.
      var classAllergies = [];
      allPeople.forEach(function (p) {
        if (p.type === 'kid' && p.group === activeFilter && p.schedule !== 'afternoon' && p.allergies) {
          classAllergies.push({ name: p.name + ' ' + (p.lastName || p.family), allergies: p.allergies });
        }
      });
      if (classAllergies.length > 0) {
        html += '<div class="class-allergy-alerts"><div class="class-allergy-title">\u26A0 Allergy & Medical Alerts</div><ul>';
        classAllergies.forEach(function (c) {
          html += '<li><strong>' + c.name + ':</strong> ' + c.allergies + '</li>';
        });
        html += '</ul></div>';
      }

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
        if (person.photoConsent === false) extras += '<div class="yb-no-photo" title="This child is opted out of photos.">⛔ No Photos</div>';

        html += '<button class="yb-card yb-card-class' + (person.photoConsent === false ? ' yb-card-no-photo' : '') + '" data-idx="' + idx + '" aria-label="' + displayName + ' ' + person.family + '">' +
          '<div class="yb-photo" style="background:' + bgStyle + '"><span>' + person.name.charAt(0) + '</span></div>' +
          '<div class="yb-name">' + displayName + '</div>' +
          '<div class="yb-subtitle">' + (person.age ? 'Age ' + person.age : '') + '</div>' +
          '<div class="yb-family">' + (person.familyDisplay || person.family) + ' Family</div>' +
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

        // Absences/coverage are parent-level (only learning coaches are ever
        // marked "out"); kids show through the parent card.
        var absenceTag = person.type === 'parent'
          ? absenceTagFor(person.name + ' ' + (person.lastName || person.family))
          : '';

        var noPhotoTag = person.photoConsent === false
          ? '<div class="yb-no-photo" title="Opted out of photos.">⛔ No Photos</div>'
          : '';

        html += '<button class="yb-card' + (person.boardRole ? ' yb-card-board' : '') + (absenceTag ? ' yb-card-absent' : '') + (person.photoConsent === false ? ' yb-card-no-photo' : '') + '" data-idx="' + idx + '" aria-label="' + displayName + ' ' + person.family + '">' +
          '<div class="yb-photo" style="background:' + bgStyle + '"><span>' + person.name.charAt(0) + '</span></div>' +
          '<div class="yb-name">' + displayName + '</div>' +
          '<div class="yb-subtitle">' + subtitle + '</div>' +
          boardTag +
          pronounTag +
          '<div class="yb-family">' + (person.familyDisplay || person.family) + ' Family</div>' +
          parentOfTag +
          absenceTag +
          noPhotoTag +
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

  // Build an AM / PM1 / PM2 mini-schedule for one directory member, scoped
  // to the currently-active session. Returns HTML (or '' when there's nothing
  // to show — e.g., a parent with no teaching role and no kids in electives
  // doesn't really have a "schedule" so we skip).
  function renderPersonDaySchedule(person, fam) {
    if (!person || !fam) return '';
    var sessInfo = SESSION_DATES[currentSession];
    if (!sessInfo) return '';

    // For a parent, scan AM classes + PM electives + support roles.
    // For a kid, pull the kid's AM group topic/room + their PM electives.
    var am = [], pm1 = [], pm2 = [];

    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    if (person.type === 'kid') {
      // AM: kid's group = their AM class
      var group = person.group;
      var amClass = group && AM_CLASSES[group];
      var amSess = amClass && amClass.sessions && amClass.sessions[currentSession];
      if (amSess) {
        var amLine = groupWithAge(group);
        if (amSess.topic) amLine += ' \u2014 ' + esc(amSess.topic);
        am.push({ label: amLine, detail: amSess.room ? esc(amSess.room) : '' });
      } else if (group) {
        am.push({ label: groupWithAge(group), detail: '' });
      }
      // PM: kid's electives
      var kidFullName = person.name + ' ' + (person.lastName || fam.name);
      var electives = getKidElectives(kidFullName) || [];
      electives.forEach(function (elec) {
        var isBoth = elec.hour === 'both';
        var target = { label: esc(elec.name), detail: elec.room ? esc(elec.room) : '' };
        if (isBoth || elec.hour === 1) pm1.push(target);
        if (isBoth || elec.hour === 2) pm2.push(target);
      });
      // Kid-only honoring the morning/afternoon flag
      if (person.schedule === 'morning') { pm1 = []; pm2 = []; }
      if (person.schedule === 'afternoon') { am = []; }
    } else {
      // Parent — scan roles
      var lastName = person.lastName || fam.name;
      var full = person.name + ' ' + lastName;
      // Normalize for comparison: collapse whitespace, swap curly quotes for
      // straight, and lowercase. Handles cross-tab spelling drift (different
      // people type different quotes / extra spaces in the same sheet).
      function norm(s) {
        return String(s == null ? '' : s)
          .replace(/[\u2018\u2019\u02BC]/g, "'")
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      }
      var fullN = norm(full);
      var myFirstN = norm(person.name).split(' ')[0];
      var myLastN = norm(lastName);
      function isMe(n) {
        if (!n) return false;
        var s = norm(n);
        if (!s) return false;
        if (s === fullN) return true;
        // Fallback for "Erin B", "Erin B.", "Aimee O'Connor Gading" (whose
        // directory parent name is "Aimee O'Connor" with family "Gading"),
        // middle initials, etc. Accept when first-name matches exactly AND
        // last word matches family name exactly OR is an abbreviation of it.
        var parts = s.split(' ');
        if (parts.length < 2) return false;
        var first = parts[0].replace(/[^a-z']/g, '');
        var last = parts[parts.length - 1].replace(/[^a-z]/g, '');
        if (first !== myFirstN) return false;
        if (last === myLastN) return true;
        if (last.length <= 2 && myLastN.length > 0 && last.charAt(0) === myLastN.charAt(0)) return true;
        return false;
      }

      // AM classes (teacher / assistant)
      Object.keys(AM_CLASSES).forEach(function (groupName) {
        var staff = AM_CLASSES[groupName];
        var sess = staff.sessions && staff.sessions[currentSession];
        if (!sess) return;
        if (isMe(sess.teacher)) {
          am.push({ label: groupWithAge(groupName) + ' \u2014 Leading', detail: sess.room ? esc(sess.room) : '' });
        }
        (sess.assistants || []).forEach(function (a) {
          if (isMe(a)) am.push({ label: groupWithAge(groupName) + ' \u2014 Assisting', detail: sess.room ? esc(sess.room) : '' });
        });
      });
      // AM support (floater / prep / board)
      var amSupport = AM_SUPPORT_ROLES && AM_SUPPORT_ROLES[currentSession];
      if (amSupport) {
        ['10-11', '11-12'].forEach(function (slot) {
          ['floaters', 'prepPeriod', 'boardDuties'].forEach(function (key) {
            var arr = amSupport[key] && amSupport[key][slot];
            if (!arr) return;
            arr.forEach(function (name) {
              if (!isMe(name)) return;
              var label = key === 'floaters' ? 'Floater' : key === 'prepPeriod' ? 'Prep Period' : 'Board Duties';
              am.push({ label: label + ' ' + slot, detail: '' });
            });
          });
        });
      }

      // PM electives (leader / assistant)
      var sessElectives = PM_ELECTIVES[currentSession] || [];
      sessElectives.forEach(function (elec) {
        var inPM1 = elec.hour === 1 || elec.hour === 'both';
        var inPM2 = elec.hour === 2 || elec.hour === 'both';
        function add(role) {
          var label = esc(elec.name) + ' \u2014 ' + role;
          var detail = elec.room ? esc(elec.room) : '';
          if (inPM1) pm1.push({ label: label, detail: detail });
          if (inPM2) pm2.push({ label: label, detail: detail });
        }
        if (isMe(elec.leader)) add('Leading');
        (elec.assistants || []).forEach(function (a) { if (isMe(a)) add('Assisting'); });
      });

      // PM support (floater / prep period / board duties / supply closet)
      var pmSupport = PM_SUPPORT_ROLES && PM_SUPPORT_ROLES[currentSession];
      if (pmSupport) {
        // Prefer hour-specific floater arrays; fall back to the combined
        // `floaters` list (surfaces on PM1 only) for older API responses.
        var flPM1 = pmSupport.floatersPM1;
        var flPM2 = pmSupport.floatersPM2;
        if (!flPM1 && !flPM2 && pmSupport.floaters) flPM1 = pmSupport.floaters;
        (flPM1 || []).forEach(function (name) { if (isMe(name)) pm1.push({ label: 'Floater', detail: 'Available to cover' }); });
        (flPM2 || []).forEach(function (name) { if (isMe(name)) pm2.push({ label: 'Floater', detail: 'Available to cover' }); });
        (pmSupport.prepPeriodPM1 || []).forEach(function (name) { if (isMe(name)) pm1.push({ label: 'Prep Period', detail: 'Room setup' }); });
        (pmSupport.prepPeriodPM2 || []).forEach(function (name) { if (isMe(name)) pm2.push({ label: 'Prep Period', detail: 'Room setup' }); });
        (pmSupport.boardDutiesPM1 || []).forEach(function (name) { if (isMe(name)) pm1.push({ label: 'Board Duties', detail: '' }); });
        (pmSupport.boardDutiesPM2 || []).forEach(function (name) { if (isMe(name)) pm2.push({ label: 'Board Duties', detail: '' }); });
        (pmSupport.supplyCloset || []).forEach(function (name) { if (isMe(name)) pm1.push({ label: 'Supply Closet', detail: 'Manage supplies' }); });
      }
    }

    // If the person has nothing in any block, skip the section entirely.
    if (am.length === 0 && pm1.length === 0 && pm2.length === 0) return '';

    // Header wording: if today is the co-op day (Wednesday) within the active
    // session, call it "Today at Co-op"; otherwise frame it around the session.
    var d = new Date();
    var nowIso = d.toISOString().slice(0, 10);
    var isCoopDay = d.getDay() === COOP_DAY_OF_WEEK && nowIso >= sessInfo.start && nowIso <= sessInfo.end;
    var title = isCoopDay ? "Today at Co-op" : "Co-op Schedule";
    var subtitle = esc(sessInfo.name);

    function renderBlock(label, times, items) {
      var inner = items.length === 0
        ? '<span class="pds-empty">Nothing scheduled</span>'
        : items.map(function (it) {
            return '<div class="pds-item"><span class="pds-label">' + it.label + '</span>'
              + (it.detail ? '<span class="pds-detail">' + it.detail + '</span>' : '')
              + '</div>';
          }).join('');
      return '<div class="pds-row' + (items.length === 0 ? ' pds-row-empty' : '') + '">'
        + '<div class="pds-block"><span class="pds-block-name">' + label + '</span><span class="pds-block-time">' + times + '</span></div>'
        + '<div class="pds-items">' + inner + '</div>'
        + '</div>';
    }

    var html = '<div class="detail-day-schedule">';
    html += '<h4 class="pds-title">' + title + ' <span class="pds-sub">' + subtitle + '</span></h4>';
    html += renderBlock('AM',  '10:00\u201312:00', am);
    html += renderBlock('PM1', '1:00\u20131:55',   pm1);
    html += renderBlock('PM2', '2:00\u20132:55',   pm2);
    html += '</div>';
    return html;
  }

  function showPersonDetail(person, boardInfo) {
    if (!personDetail || !personDetailCard) return;
    var fam = FAMILIES.filter(function(f){return f.name === person.family;})[0];
    if (!fam) return;

    var emailSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>';
    var phoneSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';

    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="detail-header">';
    // Opted-out people never resolve a photo URL — the initial placeholder shows instead.
    var detailPhotoUrl = person.photoConsent === false
      ? ''
      : person.type !== 'kid'
        ? getPhotoUrl(person.name, person.email, person.family)
        : getDbPhotoForPerson(person.name, person.email, person.family);
    if (detailPhotoUrl) {
      var hiResDetail = detailPhotoUrl.replace(/=s\d+-c/, '=s256-c');
      html += '<div class="detail-photo" style="background:' + faceColor(person.name) + '"><img src="' + hiResDetail + '" alt="' + person.name + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'\'"><span style="display:none">' + person.name.charAt(0) + '</span></div>';
    } else {
      html += '<div class="detail-photo" style="background:' + faceColor(person.name) + '"><span>' + person.name.charAt(0) + '</span></div>';
    }
    html += '<div class="detail-info">';
    // Use the parsed sheet last-word (fam.name) here. For compound surnames
    // like "Aimee O'Connor Gading", parents[0].name already carries the
    // "Aimee O'Connor" portion via parseDirectory's last-word strip, so
    // person.name + ' ' + fam.name reads "Aimee O'Connor Gading" without
    // duplication. fam.displayName is reserved for surfaces that show the
    // family name standalone (e.g. "X Family" labels) where the parsed
    // value isn't already part of the rendered string.
    var detailLast = person.lastName || fam.name;
    // Defensive dedupe: if person.name already ends with the family last
    // name (e.g. legacy data where someone entered "Aimee O'Connor Gading"
    // into the first-name field), don't double-append. Compares against
    // both fam.name (sheet-parsed) and fam.displayName (DB-corrected).
    var personFullName = String(person.name || '');
    var personLc = personFullName.toLowerCase();
    var lastLc = String(detailLast || '').toLowerCase();
    var displayLc = String(fam.displayName || '').toLowerCase();
    var headingFull = (lastLc && personLc.endsWith(' ' + lastLc)) ? personFullName
      : (displayLc && personLc.endsWith(' ' + displayLc)) ? personFullName
      : (personFullName + ' ' + detailLast);
    html += '<h3>' + headingFull + '</h3>';
    if (boardInfo) {
      html += '<p class="detail-board-role">' + boardInfo.role + '</p>';
    }
    if (person.type === 'kid') {
      html += '<p class="detail-group">' + (person.age ? 'Age ' + person.age + ' &middot; ' : '') + groupWithAge(person.group) + '</p>';
      if (person.pronouns) html += '<p class="detail-pronouns">' + person.pronouns + '</p>';
      if (person.schedule && person.schedule !== 'all-day') {
        html += '<p class="detail-schedule">' + (person.schedule === 'morning' ? 'Morning only' : 'Afternoon only') + '</p>';
      }
      if (person.allergies) html += '<p class="detail-allergy-info">Allergies / Medical: ' + person.allergies + '</p>';
      if (person.photoConsent === false) html += '<p class="detail-no-photo">⛔ No Photos — this child is opted out of photos in co-op materials.</p>';
      html += '<p class="detail-parents">Parents: ' + fam.parents + '</p>';
    } else {
      // Role badge for adults: Main Learning Coach / Back Up LC / Parent
      // (P4 of directory→DB migration). Falls back to "Parent" when the
      // person doesn't yet have a role tagged in the DB.
      var roleLabels = { mlc: 'Main Learning Coach', blc: 'Back Up Learning Coach', parent: 'Parent' };
      var personRoleLabel = roleLabels[person.role] || 'Parent';
      if (!boardInfo) html += '<p class="detail-group">' + personRoleLabel + '</p>';
      if (person.pronouns) html += '<p class="detail-pronouns">' + person.pronouns + '</p>';
      if (person.photoConsent === false) html += '<p class="detail-no-photo">⛔ No Photos — opted out of photo and film use.</p>';
      // Kids shown in family grid below
    }
    html += '</div></div>';

    // Per-person contact (P4): use the parent's own workspace email,
    // personal email (if filled in), and phone. Falls back to fam-level
    // values when a person-level field is empty (legacy rows without the
    // backfill, or families that haven't filled in personal info yet).
    var contactEmailWs = (person.type !== 'kid' && person.email) ? person.email : fam.email;
    var contactEmailPersonal = (person.type !== 'kid' && person.personalEmail) ? person.personalEmail : '';
    var contactPhone = (person.type !== 'kid' && person.phone) ? person.phone : (fam.phone || '');
    html += '<div class="detail-contact">';
    if (boardInfo) {
      html += '<a href="mailto:' + boardInfo.email + '" class="detail-btn detail-btn-board">';
      html += emailSvg + ' ' + boardInfo.email + ' <small>(' + boardInfo.role + ')</small></a>';
    }
    html += '<a href="mailto:' + contactEmailWs + '" class="detail-btn detail-btn-email">';
    html += emailSvg + ' ' + contactEmailWs + (boardInfo ? ' <small>(personal)</small>' : '') + '</a>';
    if (contactEmailPersonal) {
      html += '<a href="mailto:' + contactEmailPersonal + '" class="detail-btn detail-btn-email">';
      html += emailSvg + ' ' + contactEmailPersonal + ' <small>(personal)</small></a>';
    }
    if (contactPhone) {
      html += '<a href="tel:' + String(contactPhone).replace(/[^+\d]/g, '') + '" class="detail-btn detail-btn-phone">';
      html += phoneSvg + ' ' + contactPhone + '</a>';
    }
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
    html += '<h4>' + (fam.displayName || fam.name) + ' Family</h4>';
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

    // ──── Today's co-op schedule for this person (below family grid) ────
    var scheduleHtml = renderPersonDaySchedule(person, fam);
    if (scheduleHtml) html += scheduleHtml;

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

  // Print the current duty-detail card via a hidden iframe. Using an iframe
  // instead of window.open sidesteps popup blockers (which were rendering
  // the print window blank in some browsers) and keeps the paper copy
  // self-contained. Whichever variant of the popup was rendered — AM class,
  // committee, cleaning, board — gets printed with matching content.
  function printDetailCard(title) {
    if (!personDetailCard) return;
    var clone = personDetailCard.cloneNode(true);
    clone.querySelectorAll('.no-print, .detail-close').forEach(function (el) { el.remove(); });
    var safeTitle = String(title || 'Roots & Wings — Responsibility')
      .replace(/[<>]/g, '').trim();

    var styles = [
      '@page { margin: 0.6in; }',
      'html, body { background: #fff; }',
      'body { font-family: -apple-system, "Source Sans 3", "Segoe UI", sans-serif; color: #2a2420; line-height: 1.5; padding: 0; margin: 0; }',
      'h1 { font-family: "Playfair Display", Georgia, serif; font-size: 1.4rem; margin: 0 0 0.25rem; color: #4a2d3a; }',
      'h3 { font-family: "Playfair Display", Georgia, serif; margin-top: 0.5rem; color: #4a2d3a; }',
      'h4 { font-size: 1rem; margin: 1rem 0 0.35rem; color: #4a2d3a; }',
      '.print-header { border-bottom: 1px solid #d8c9b9; padding-bottom: 0.5rem; margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; }',
      '.print-brand { font-size: 0.85rem; color: #7a6857; text-transform: uppercase; letter-spacing: 0.08em; }',
      '.elective-meta { display: flex; gap: 1rem; flex-wrap: wrap; color: #7a6857; font-size: 0.9rem; margin-bottom: 0.75rem; }',
      '.elective-staff-list { display: flex; flex-direction: column; gap: 0.4rem; margin: 0.5rem 0 1rem; }',
      '.elective-teacher { display: flex; align-items: center; gap: 0.6rem; }',
      '.staff-dot { width: 24px !important; height: 24px !important; min-width: 24px; border-radius: 50%; background: #ddd; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 600; font-size: 0.75rem; }',
      '.elective-roster { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.4rem 1rem; margin: 0.4rem 0 1rem; }',
      '.elective-student { display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; }',
      '.elective-student-dot { width: 22px; height: 22px; border-radius: 50%; background: #ddd; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 600; }',
      '.rd-section { margin-top: 1rem; padding-top: 0.75rem; border-top: 1px dashed #d8c9b9; }',
      'ul { padding-left: 1.2rem; margin: 0.3rem 0; }',
      'li { margin: 0.15rem 0; }',
      'a { color: inherit; text-decoration: none; }',
      '.no-print { display: none !important; }',
      '@media print { body { margin: 0; } }'
    ].join('\n');

    var today = new Date().toLocaleDateString();
    var docHtml =
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>' + safeTitle + ' — Roots & Wings</title>' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;700&family=Source+Sans+3:wght@400;600&display=swap">' +
      '<style>' + styles + '</style>' +
      '</head><body>' +
      '<div class="print-header">' +
        '<h1>' + safeTitle + '</h1>' +
        '<span class="print-brand">Roots &amp; Wings &middot; ' + today + '</span>' +
      '</div>' +
      clone.innerHTML +
      '</body></html>';

    openPrintIframe(docHtml);
  }

  // Responsibility detail popup
  function showDutyDetail(duty) {
    if (!duty.popup || !personDetail || !personDetailCard) return;
    var p = duty.popup;
    // Unified modal header: Print button sits as a sibling of the close X
    // in the top-right corner (see `.detail-actions` in styles.css). This
    // is the shared navigation pattern used across all modals with actions.
    var html = '<div class="detail-actions no-print">';
    html += '<button type="button" class="sc-btn duty-print-btn" aria-label="Print this role and class info">\u2399 Print</button>';
    html += '</div>';
    html += '<button class="detail-close" aria-label="Close">&times;</button>';
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
        var teacherPerson = lookupPerson(sess.teacher);
        var teacherEmail = teacherPerson ? teacherPerson.email : '';
        var teacherFamily = teacherPerson ? teacherPerson.family : '';
        html += '<div class="elective-teacher">';
        html += '<div class="staff-dot" style="background:' + faceColor(sess.teacher) + ';width:36px;height:36px;overflow:hidden;">' + photoHtml(sess.teacher, sess.teacher, teacherEmail, teacherFamily) + '</div>';
        html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + sess.teacher + pronounTag(teacherPerson) + '</strong><small style="color:var(--color-text-light);">Leader</small></div>';
        html += '</div>';
      }
      if (sess && sess.assistants) {
        sess.assistants.forEach(function(a) {
          var assistPerson = lookupPerson(a);
          var aEmail = assistPerson ? assistPerson.email : '';
          var aFamily = assistPerson ? assistPerson.family : '';
          html += '<div class="elective-teacher">';
          html += '<div class="staff-dot" style="background:' + faceColor(a) + ';width:36px;height:36px;overflow:hidden;">' + photoHtml(a, a, aEmail, aFamily) + '</div>';
          html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + a + pronounTag(assistPerson) + '</strong><small style="color:var(--color-text-light);">Assistant</small></div>';
          html += '</div>';
        });
      }
      html += '</div>';
      // Show kids in this group
      var groupKids = allPeople.filter(function(person) { return person.type === 'kid' && person.group === p.group; });
      if (groupKids.length > 0) {
        var studentFullNames = groupKids.map(function (kid) { return kid.name + ' ' + (kid.lastName || kid.family); });
        html += '<h4 class="elective-roster-title">' + groupKids.length + ' Students</h4>';
        // Allergy / medical alerts surface BEFORE the roster so they're visible
        // without scrolling on smaller modals.
        html += studentAllergyCallout(studentFullNames);
        html += '<div class="elective-roster">';
        groupKids.forEach(function(kid) {
          var noPhoto = kid.photoConsent === false ? ' <span class="elective-student-nophoto" title="Opted out of photo and film">⛔ No Photos</span>' : '';
          html += '<div class="elective-student' + (kid.photoConsent === false ? ' elective-student-nophoto-card' : '') + '">';
          html += '<div class="elective-student-dot" style="background:' + faceColor(kid.name) + '">' + kidAvatarInnerHtml(kid.name, kid.email, kid.family) + '</div>';
          html += '<div><strong>' + kid.name + '</strong> <span class="elective-student-last">' + (kid.lastName || kid.family) + '</span>' + pronounTag(kid) + noPhoto + '</div>';
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
      // Prefer DB tasks over hardcoded
      var dbTasks = null;
      if (cleaningDB.loaded) {
        for (var ai = 0; ai < cleaningDB.areas.length; ai++) {
          if (cleaningDB.areas[ai].area_name === p.area) { dbTasks = cleaningDB.areas[ai].tasks; break; }
        }
      }
      var yourTasks = dbTasks || CLEANING_TASKS[p.area] || CLEANING_TASKS[p.area.replace(/\s*$/, '')] || null;
      if (yourTasks) {
        html += '<div style="background:var(--color-primary-ghost);border-radius:12px;padding:1rem;margin-bottom:1rem;">';
        html += '<h4 style="margin:0 0 0.75rem;font-size:0.95rem;">Your Assignment: ' + p.area + '</h4>';
        html += '<ul style="margin:0;padding-left:1.5rem;font-size:0.85rem;line-height:1.7;list-style:disc;">';
        yourTasks.forEach(function(task) {
          html += '<li style="margin-bottom:4px;padding-left:4px;">' + task + '</li>';
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
      var normalizeTitle = function(t) { return (t || '').trim().replace(/\bDir\.\s*$/, 'Director').toLowerCase(); };
      VOLUNTEER_COMMITTEES.forEach(function(c) {
        if (c.chair && c.chair.title && p.role && normalizeTitle(c.chair.title) === normalizeTitle(p.role)) committee = c;
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

    // Append role description if available
    var popupRoleKey = getRoleKeyForDuty(duty.text);
    if (popupRoleKey) html += renderRoleDescriptionSection(popupRoleKey);

    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) {
      if (e.target === personDetail) closeDetail();
    });
    var printBtn = personDetailCard.querySelector('.duty-print-btn');
    if (printBtn) printBtn.addEventListener('click', function () { printDetailCard(duty.text || 'My Responsibility'); });
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

  // Directory modal — opened from the nav quick-icons row. Person-card
  // taps still open the shared #personDetail overlay, which stacks on top
  // (higher z-index) so Close returns the user to the directory grid.
  var directoryOverlay = document.getElementById('directoryOverlay');
  function showDirectoryModal() {
    if (!directoryOverlay) return;
    renderDirectory();
    directoryOverlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }
  function closeDirectoryModal() {
    if (!directoryOverlay) return;
    directoryOverlay.style.display = 'none';
    if (!personDetail || personDetail.style.display === 'none') {
      document.body.style.overflow = '';
    }
  }
  var directoryNavBtn = document.getElementById('directoryNavBtn');
  if (directoryNavBtn) directoryNavBtn.addEventListener('click', showDirectoryModal);
  if (directoryOverlay) {
    var directoryCloseBtn = directoryOverlay.querySelector('.directory-close');
    if (directoryCloseBtn) directoryCloseBtn.addEventListener('click', closeDirectoryModal);
    directoryOverlay.addEventListener('click', function (e) {
      if (e.target === directoryOverlay) closeDirectoryModal();
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    // Only close the directory if the person-detail overlay isn't the
    // top-most modal — otherwise let the existing Escape handler close
    // the person card first.
    if (directoryOverlay && directoryOverlay.style.display === 'flex'
        && (!personDetail || personDetail.style.display === 'none')) {
      closeDirectoryModal();
    }
  });

  // Calendar modal — opened from the calendar nav icon. Events are
  // populated by loadCalendar() into #calendarEvents regardless of modal
  // visibility, so the first open is instant if the cache is warm.
  var calendarOverlay = document.getElementById('calendarOverlay');
  var calendarNavBtn = document.getElementById('calendarNavBtn');
  if (calendarOverlay && calendarNavBtn) {
    calendarNavBtn.addEventListener('click', function () {
      calendarOverlay.style.display = 'flex';
      document.body.style.overflow = 'hidden';
    });
    var calClose = calendarOverlay.querySelector('.calendar-close');
    if (calClose) calClose.addEventListener('click', function () {
      calendarOverlay.style.display = 'none';
      document.body.style.overflow = '';
    });
    calendarOverlay.addEventListener('click', function (e) {
      if (e.target === calendarOverlay) {
        calendarOverlay.style.display = 'none';
        document.body.style.overflow = '';
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && calendarOverlay.style.display === 'flex'
          && (!personDetail || personDetail.style.display === 'none')) {
        calendarOverlay.style.display = 'none';
        document.body.style.overflow = '';
      }
    });
  }

  // Address modal — opened from the map pin nav icon.
  var addressOverlay = document.getElementById('addressOverlay');
  var addressNavBtn = document.getElementById('addressNavBtn');
  if (addressOverlay && addressNavBtn) {
    addressNavBtn.addEventListener('click', function () {
      addressOverlay.style.display = 'flex';
      document.body.style.overflow = 'hidden';
    });
    var addrClose = addressOverlay.querySelector('.address-close');
    if (addrClose) addrClose.addEventListener('click', function () {
      addressOverlay.style.display = 'none';
      document.body.style.overflow = '';
    });
    addressOverlay.addEventListener('click', function (e) {
      if (e.target === addressOverlay) {
        addressOverlay.style.display = 'none';
        document.body.style.overflow = '';
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && addressOverlay.style.display === 'flex'
          && (!personDetail || personDetail.style.display === 'none')) {
        addressOverlay.style.display = 'none';
        document.body.style.overflow = '';
      }
    });
  }

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

  // ── Billing config ──
  // Per-family status + semester rates are loaded live from the billing sheet
  // via /api/sheets?action=billing — see billingStatus below. The static bits
  // below (deposit amount, per-session class rates, PayPal constants) don't
  // change mid-year and remain hardcoded.
  // Active school year flips on April 1. Registrations go out in late
  // April for the upcoming year, and class fees are due before classes
  // start (Aug for Fall, Jan for Spring), so April is the natural pivot
  // for surfacing the upcoming year's billing card to families.
  // Returns { fallYear, springYear, label } e.g. { 2026, 2027, '2026-2027' }.
  function activeSchoolYear(now) {
    now = now || new Date();
    var fallYear = (now.getMonth() < 3) ? now.getFullYear() - 1 : now.getFullYear();
    return { fallYear: fallYear, springYear: fallYear + 1, label: fallYear + '-' + (fallYear + 1) };
  }
  var ACTIVE_YEAR = activeSchoolYear();

  // 2026-2027 deposit-only: the board decided this year's My Family
  // billing card shows only the membership/deposit fee — no per-session
  // class fees.
  //
  // TODO (Spring 2027 membership fee): the Spring deposit subsection
  // needs TWO PayPal-fee line items, broken out so families see what
  // they're paying for:
  //   1. "Fall 2026 PayPal transaction fee" — recoups the ~2.5% PayPal
  //      fee the org absorbed on each Fall registration payment ($40
  //      went in, ~$38.70 reached the co-op). Per-family amount comes
  //      from billingStatus / payments.amount_cents on the Fall
  //      'deposit' row for that family.
  //   2. "Spring 2027 PayPal transaction fee" — the standard processing
  //      fee on the new Spring membership fee itself, computed the same
  //      way the deposit subsection already computes depositPaypalFee.
  // Both line items roll into the Spring deposit's Balance due / Pay
  // button total so the family pays once.
  var DEPOSIT_ONLY_YEAR = ACTIVE_YEAR.label === '2026-2027';

  // Each subsection (deposit OR class fees) appears 2 weeks before its
  // due date so families get lead time without seeing the card months
  // early (which also avoids prior-year billing-sheet "Paid" markers
  // bleeding through into a fresh view). Implicit upper bound is the
  // April 1 ACTIVE_YEAR flip — after that, the next year's due dates
  // drive visibility.
  function withinTwoWeeksOf(dateStr) {
    var due = new Date(dateStr + 'T00:00:00');
    var leadStart = new Date(due);
    leadStart.setDate(leadStart.getDate() - 14);
    return new Date() >= leadStart;
  }

  var FALL_DUE_DATE = ACTIVE_YEAR.fallYear + '-08-27';
  var SPRING_DUE_DATE = ACTIVE_YEAR.springYear + '-01-07';
  var SHOW_SPRING = withinTwoWeeksOf(SPRING_DUE_DATE);
  var SHOW_FALL_CLASS_FEES = !DEPOSIT_ONLY_YEAR && withinTwoWeeksOf(FALL_DUE_DATE);
  var SHOW_SPRING_CLASS_FEES = !DEPOSIT_ONLY_YEAR && withinTwoWeeksOf(SPRING_DUE_DATE);

  var BILLING_CONFIG = {
    memberFeePerSemester: 40, // fallback; overridden by billingStatus.rates
    amFeePerSession: 10,
    pmFeePerSession: 10,
    paypalFeeRate: 0.0199,
    paypalFeeFixed: 0.49,
    checkPayableTo: 'Roots and Wings Homeschool, Inc.',
    checkDeliverTo: 'Jessica Shewan (Treasurer)',
    paypalMerchantId: 'MHDL7HTNRVQHE',
    semesters: {
      fall:   { name: 'Fall '   + ACTIVE_YEAR.fallYear,   sessions: [1, 2],     dueDate: FALL_DUE_DATE,   deposit: 40, showClassFees: SHOW_FALL_CLASS_FEES,   visible: true },
      spring: { name: 'Spring ' + ACTIVE_YEAR.springYear, sessions: [3, 4, 5], dueDate: SPRING_DUE_DATE, deposit: 50, showClassFees: SHOW_SPRING_CLASS_FEES, visible: SHOW_SPRING }
    }
  };

  // Live billing state: { rates: { fall: {amRate, pmRate}, spring: {...} },
  //                       families: { 'smith': { name, fall: {deposit, classFee}, spring: {...} } } }
  // Populated by loadBillingStatus(); reused by calculateSemesterFees().
  var billingStatus = null;
  var billingStatusLoaded = false;

  function loadBillingStatus(cb) {
    var googleCred = localStorage.getItem('rw_google_credential');
    if (!googleCred) { if (cb) cb(); return; }
    fetch('/api/sheets?action=billing&school_year=' + encodeURIComponent(ACTIVE_YEAR.label), {
      headers: { 'Authorization': 'Bearer ' + googleCred }
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && !data.error) {
          billingStatus = data;
        }
        billingStatusLoaded = true;
        if (cb) cb();
      })
      .catch(function (e) {
        console.warn('[billing] status load failed:', e);
        billingStatusLoaded = true;
        if (cb) cb();
      });
  }

  function getFamilyBillingStatus(fam, semKey) {
    if (!fam || !billingStatus || !billingStatus.families) {
      return { deposit: 'Due', classFee: 'Due' };
    }
    var entry = billingStatus.families[String(fam.name || '').toLowerCase()];
    if (!entry || !entry[semKey]) return { deposit: 'Due', classFee: 'Due' };
    var sem = entry[semKey];
    return {
      deposit: sem.deposit || 'Due',
      classFee: sem.classFee || 'Due'
    };
  }

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
    // Member fee from live sheet rates when available (AM + PM halves).
    var memberFee = BILLING_CONFIG.memberFeePerSemester;
    if (billingStatus && billingStatus.rates && billingStatus.rates[semesterKey]) {
      var r = billingStatus.rates[semesterKey];
      var live = (r.amRate || 0) + (r.pmRate || 0);
      if (live > 0) memberFee = live;
    }
    var deposit = sem.deposit || 0;
    // Class Fees cover AM/PM class charges only. Member / Membership fees are
    // billed as their own payments and no longer roll into the class-fee
    // subtotal or credit.
    var subtotal = classTotal;
    var balanceBeforeFee = subtotal;
    var paypalFee = Math.ceil(((balanceBeforeFee + BILLING_CONFIG.paypalFeeFixed) / (1 - BILLING_CONFIG.paypalFeeRate) - balanceBeforeFee) * 100) / 100;
    var total = balanceBeforeFee + paypalFee;
    // Deposit/membership-fee gets its own PayPal fee added on top so the
    // org isn't absorbing transaction costs on it. Computed separately
    // because it's a separate PayPal transaction from the class fees.
    var depositPaypalFee = deposit
      ? Math.ceil(((deposit + BILLING_CONFIG.paypalFeeFixed) / (1 - BILLING_CONFIG.paypalFeeRate) - deposit) * 100) / 100
      : 0;
    var depositTotal = deposit + depositPaypalFee;

    // Live per-family status (falls back to 'Due' if sheet hasn't loaded).
    var live = getFamilyBillingStatus(fam, semesterKey);

    // Per-family visibility. Base visibility comes from BILLING_CONFIG
    // (e.g. Spring is hidden Apr-Oct). For 2026-27 specifically, the
    // Fall membership fee subsection is also hidden from families who
    // haven't yet registered — no point prompting them with a fee until
    // they go through the registration form. Once they pay (Paid OR
    // Pending), the card surfaces so they can see the receipt.
    var visible = sem.visible !== false;
    if (visible && ACTIVE_YEAR.label === '2026-2027' && semesterKey === 'fall') {
      var depStatus = live.deposit || 'Due';
      visible = (depStatus === 'Paid' || depStatus === 'Pending');
    }

    return {
      name: sem.name,
      status: live.classFee || 'Due',
      depositStatus: live.deposit || 'Due',
      dueDate: sem.dueDate,
      memberFee: memberFee,
      deposit: deposit,
      depositPaypalFee: depositPaypalFee,
      depositTotal: depositTotal,
      sessionFees: sessionFees,
      classTotal: classTotal,
      subtotal: subtotal,
      balanceBeforeFee: balanceBeforeFee,
      paypalFee: paypalFee,
      total: total,
      sessionCount: sem.sessions.length,
      showClassFees: sem.showClassFees !== false,
      visible: visible
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
    var email = getActiveEmail();
    var section = document.getElementById('myFamily');
    var grid = document.getElementById('myFamilyGrid');
    var greeting = document.getElementById('dashboardGreeting');
    if (!email || !section || !grid) return;

    // Find the family by email
    var fam = null;
    for (var i = 0; i < FAMILIES.length; i++) {
      if (familyMatchesEmail(FAMILIES[i], email)) { fam = FAMILIES[i]; break; }
    }

    var html = '';

    // ──── View As banner (communications@ only, when impersonating) ────
    // The picker itself lives in the sticky header (see renderHeaderViewAs);
    // the banner below just makes it obvious which family is in view and
    // offers a one-click "back to my view" button.
    var viewAsEmail = sessionStorage.getItem(VIEW_AS_KEY);
    if (isCommsUser() && viewAsEmail && fam) {
      html += '<div class="view-as-bar">';
      html += '<div class="view-as-banner">';
      html += '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      // If the View As email resolves to a specific co-parent (e.g.
      // jays@ for the Shewan family), label the banner with just that
      // person — "Jay Shewan" — not the family's joined parents string
      // ("Jessica & Jay Shewan"). Falls back to the family-level label
      // for single-login families or when derivation can't infer.
      var viewAsFirst = deriveFirstNameFromLogin(viewAsEmail, fam.name);
      var viewAsLabel = (Array.isArray(fam.loginEmails) && fam.loginEmails.length > 1 && viewAsFirst)
        ? (viewAsFirst + ' ' + fam.name)
        : (fam.parents + ' ' + fam.name);
      html += ' Viewing as <strong>' + viewAsLabel + '</strong>';
      html += '<button class="view-as-reset" id="viewAsReset">Back to my view</button>';
      html += '</div>';
      html += '</div>';
    }

    // If no matching family (e.g. communications@ with no View As), show
    // empty-state prompt pointing to the header picker.
    if (!fam) {
      if (isCommsUser()) {
        html += '<div class="mf-card mf-card-full"><p>Pick a family from the <strong>View as</strong> dropdown in the header to see their dashboard, or switch to My Workspace.</p></div>';
      }
      grid.innerHTML = html;
      section.style.display = '';
      renderHeaderViewAs();
      if (greeting) greeting.textContent = 'Welcome!';
      // Empty state (no active family) — hide the plant badge.
      if (typeof loadParticipationBadge === 'function') loadParticipationBadge();
      return;
    }

    // Personalize greeting. Use the login-email derivation so a co-parent
    // (e.g. Jay logging in as jays@) sees their own name, not the family's
    // primary parent. Falls back to the first parent string if the
    // derivation can't infer (e.g. unusual email shape).
    var derivedFirst = deriveFirstNameFromLogin(email, fam.name);
    var firstName = derivedFirst || fam.parents.split(' & ')[0].split(' ')[0];
    if (greeting) greeting.textContent = 'Welcome, ' + firstName + '!';

    // ──── Coverage Board (full width, collapsible) ────
    html += '<details class="mf-card mf-card-full mf-coverage-details" id="coverageBoardCard" style="display:none;" open>';
    html += '<summary class="mf-card-title mf-coverage-summary">Coverage Board <span class="coverage-summary-badge" id="coverageSummaryBadge"></span></summary>';
    html += '<p class="coverage-intro">See who needs coverage and volunteer to help.</p>';
    html += '<div id="coverageBoardContent"></div>';
    html += '</details>';

    // ──── Responsibilities card (first on mobile) ────
    html += '<div class="mf-card">';
    html += '<h3 class="mf-card-title">My Responsibilities</h3>';
    var duties = [];
    var parentFullNames = fam.parents.split(' & ').map(function(p) { return p.trim() + ' ' + fam.name; });

    function nameMatch(a, b) {
      if (!a || !b) return false;
      return a.trim().toLowerCase() === b.trim().toLowerCase();
    }

    // ── AM duties ──
    Object.keys(AM_CLASSES).forEach(function (groupName) {
      var staff = AM_CLASSES[groupName];
      var sess = staff.sessions[currentSession];
      if (!sess) return;
      parentFullNames.forEach(function (full) {
        if (nameMatch(staff.liaison, full)) {
          duties.push({block: 'annual', icon: 'star', text: groupWithAge(groupName) + ' Class Liaison', detail: 'Year-long role', popup: {type: 'amClass', group: groupName, session: currentSession}});
        }
        if (nameMatch(sess.teacher, full)) {
          duties.push({block: 'AM', icon: 'teach', text: groupWithAge(groupName) + ' \u2014 Leading', detail: '10:00\u201312:00 \u00b7 ' + (sess.room || ''), popup: {type: 'amClass', group: groupName, session: currentSession}});
        }
        sess.assistants.forEach(function (a) {
          if (nameMatch(a, full)) {
            duties.push({block: 'AM', icon: 'assist', text: groupWithAge(groupName) + ' \u2014 Assisting', detail: '10:00\u201312:00 \u00b7 ' + (sess.room || ''), popup: {type: 'amClass', group: groupName, session: currentSession}});
          }
        });
      });
    });

    // AM support roles (floater, prep, board duties)
    var amSupport = AM_SUPPORT_ROLES[currentSession];
    if (amSupport) {
      ['10-11', '11-12'].forEach(function (slot) {
        if (amSupport.floaters && amSupport.floaters[slot]) {
          amSupport.floaters[slot].forEach(function (name) {
            parentFullNames.forEach(function (full) {
              if (nameMatch(name, full)) duties.push({block: 'AM', icon: 'assist', text: 'Floater ' + slot, detail: 'Available to cover classes', popup: null});
            });
          });
        }
        if (amSupport.prepPeriod && amSupport.prepPeriod[slot]) {
          amSupport.prepPeriod[slot].forEach(function (name) {
            parentFullNames.forEach(function (full) {
              if (nameMatch(name, full)) duties.push({block: 'AM', icon: 'assist', text: 'Prep Period ' + slot, detail: 'Room setup', popup: null});
            });
          });
        }
        if (amSupport.boardDuties && amSupport.boardDuties[slot]) {
          amSupport.boardDuties[slot].forEach(function (name) {
            parentFullNames.forEach(function (full) {
              if (nameMatch(name, full)) duties.push({block: 'AM', icon: 'board', text: 'Board Duties ' + slot, detail: 'Board work time', popup: null});
            });
          });
        }
      });
    }

    // ── PM duties ──
    var sessElectives = PM_ELECTIVES[currentSession] || [];
    sessElectives.forEach(function (elec) {
      var isPM1 = elec.hour === 1 || elec.hour === 'both';
      var isPM2 = elec.hour === 2 || elec.hour === 'both';
      parentFullNames.forEach(function (full) {
        if (nameMatch(elec.leader, full)) {
          if (isPM1) duties.push({block: 'PM1', icon: 'teach', text: elec.name + ' \u2014 Leading', detail: '1:00\u20131:55 \u00b7 ' + (elec.room || ''), popup: {type: 'elective', name: elec.name}});
          if (isPM2) duties.push({block: 'PM2', icon: 'teach', text: elec.name + ' \u2014 Leading', detail: '2:00\u20132:55 \u00b7 ' + (elec.room || ''), popup: {type: 'elective', name: elec.name}});
        }
        if (elec.assistants) elec.assistants.forEach(function(a) {
          if (nameMatch(a, full)) {
            if (isPM1) duties.push({block: 'PM1', icon: 'assist', text: elec.name + ' \u2014 Assisting', detail: '1:00\u20131:55 \u00b7 ' + (elec.room || ''), popup: {type: 'elective', name: elec.name}});
            if (isPM2) duties.push({block: 'PM2', icon: 'assist', text: elec.name + ' \u2014 Assisting', detail: '2:00\u20132:55 \u00b7 ' + (elec.room || ''), popup: {type: 'elective', name: elec.name}});
          }
        });
      });
    });

    // PM support roles
    var pmSupport = PM_SUPPORT_ROLES[currentSession];
    if (pmSupport) {
      if (pmSupport.floaters) pmSupport.floaters.forEach(function (name) {
        parentFullNames.forEach(function (full) {
          if (nameMatch(name, full)) duties.push({block: 'PM1', icon: 'assist', text: 'PM Floater', detail: 'Available to cover classes', popup: null});
        });
      });
      if (pmSupport.boardDutiesPM1) pmSupport.boardDutiesPM1.forEach(function (name) {
        parentFullNames.forEach(function (full) {
          if (nameMatch(name, full)) duties.push({block: 'PM1', icon: 'board', text: 'Board Duties', detail: '1:00\u20131:55 \u00b7 Board work time', popup: null});
        });
      });
      if (pmSupport.boardDutiesPM2) pmSupport.boardDutiesPM2.forEach(function (name) {
        parentFullNames.forEach(function (full) {
          if (nameMatch(name, full)) duties.push({block: 'PM2', icon: 'board', text: 'Board Duties', detail: '2:00\u20132:55 \u00b7 Board work time', popup: null});
        });
      });
      if (pmSupport.supplyCloset) pmSupport.supplyCloset.forEach(function (name) {
        parentFullNames.forEach(function (full) {
          if (nameMatch(name, full)) duties.push({block: 'PM1', icon: 'assist', text: 'Supply Closet', detail: 'Manage supplies', popup: null, manage: 'supplyCloset'});
        });
      });
    }

    // ── Cleaning ──
    var hasCleaning = false;
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
        Object.keys(sessClean[floor]).forEach(function (area) {
          if (matchesCleaning(sessClean[floor][area])) {
            hasCleaning = true;
            duties.push({block: 'Cleaning', icon: 'clean', text: 'Cleaning: ' + area, detail: 'Session ' + currentSession, popup: {type: 'cleaning', area: area, floor: floor, session: currentSession}});
          }
        });
      });
      if (sessClean.floater && matchesCleaning(sessClean.floater)) {
        hasCleaning = true;
        duties.push({block: 'Cleaning', icon: 'clean', text: 'Cleaning Floater', detail: 'Session ' + currentSession, popup: {type: 'cleaning', area: 'Floater', floor: 'floater', session: currentSession}});
      }
    }

    // ── Coverage (covering for someone on an upcoming co-op day) ──
    // If any parent in this family has claimed a slot for an absence dated
    // today-or-later, surface that slot alongside their regular AM/PM1/PM2
    // duties. We don't tie to getNextCoopDate() because absences can be
    // entered for any date (including legacy non-Wednesday dates); the
    // Coverage Board renders the same way.
    try {
      var todayIsoCov = new Date().toISOString().slice(0, 10);
      (loadedAbsences || []).forEach(function (a) {
        var absDate = String(a.absence_date || '').slice(0, 10);
        if (!absDate || absDate < todayIsoCov) return;
        (a.slots || []).forEach(function (s) {
          if (!s.claimed_by_email && !s.claimed_by_name) return;
          var mine = parentFullNames.some(function (full) { return nameMatch(s.claimed_by_name, full); });
          if (!mine) return;
          var blk = (s.block === 'AM' || s.block === 'PM1' || s.block === 'PM2' || s.block === 'Cleaning') ? s.block : 'AM';
          var icon = s.role_type === 'teacher' ? 'teach' : s.role_type === 'cleaning' ? 'clean' : 'assist';
          var absentPerson = a.absent_person || 'a member';
          var dateLbl = formatDateLabel(absDate).replace(/^\w+,\s*/, '');
          var text = 'Covering: ' + (s.role_description || 'role');
          var detail = 'For ' + absentPerson + ' \u00b7 ' + dateLbl;
          // If the slot maps to a known class/elective, build a popup link.
          var popup = null;
          if (s.block === 'AM' && s.group_or_class && AM_CLASSES[s.group_or_class]) {
            popup = { type: 'amClass', group: s.group_or_class, session: currentSession };
          } else if ((s.block === 'PM1' || s.block === 'PM2') && s.group_or_class) {
            popup = { type: 'elective', name: s.group_or_class };
          } else if (s.block === 'Cleaning' && s.group_or_class) {
            popup = { type: 'cleaning', area: s.group_or_class, floor: s.group_or_class === 'Floater' ? 'floater' : '', session: currentSession };
          }
          duties.push({ block: blk, icon: icon, text: text, detail: detail, popup: popup, isCoverage: true, slotId: s.id });
          if (blk === 'Cleaning') hasCleaning = true;
        });
      });
    } catch (covErr) { console.error('coverage duty injection failed:', covErr); }

    // ── Annual roles (board, committees, events) ──
    // Board role is held by ONE person, not the whole family. Only inject
    // it as a duty for the active user when they're the primary family_email
    // holder — co-parents don't inherit their spouse's board role.
    if (fam.boardRole && String(fam.email || '').toLowerCase() === String(email || '').toLowerCase()) {
      duties.push({block: 'annual', icon: 'board', text: fam.boardRole, detail: 'Board of Directors &middot; 2-year term', popup: {type: 'board', role: fam.boardRole}});
    }
    VOLUNTEER_COMMITTEES.forEach(function (committee) {
      if (committee.chair && committee.chair.person) {
        var chairTitle = committee.chair.title.replace(/\bDir\.\s*$/, 'Director');
        if (!fam.boardRole || !nameMatch(chairTitle, fam.boardRole)) {
          parentFullNames.forEach(function (full) {
            if (nameMatch(committee.chair.person, full))
              duties.push({block: 'annual', icon: 'volunteer', text: committee.chair.title + ' (' + committee.name + ')', detail: 'Board &middot; Year-long', popup: {type: 'committee', name: committee.name}});
          });
        }
      }
      committee.roles.forEach(function (r) {
        parentFullNames.forEach(function (full) {
          if (nameMatch(r.person, full)) {
            var duty = {block: 'annual', icon: 'volunteer', text: r.title, detail: committee.name + ' &middot; Year-long', popup: {type: 'committee', name: committee.name}};
            if (r.title === 'Cleaning Crew Liaison') duty.manage = 'cleaningCrew';
            if (r.title === 'Supply Coordinator') duty.manage = 'supplyCloset';
            duties.push(duty);
          }
        });
      });
    });
    // ── Dynamic Cleaning Crew Liaison (from DB or cache) ──
    var dbLiaison = CLEANING_CREW.liaison;
    // Also check localStorage cache directly in case DB fetch hasn't completed
    if (!cleaningDB.loaded) {
      try {
        var cc = localStorage.getItem(CACHE_CLEANING_KEY);
        if (cc) { var ccd = JSON.parse(cc); if (ccd.liaison) dbLiaison = ccd.liaison; }
      } catch (e) { /* ignore */ }
    }
    if (dbLiaison) {
      var liaisonAlreadyShown = duties.some(function (d) { return d.text === 'Cleaning Crew Liaison'; });
      if (!liaisonAlreadyShown) {
        parentFullNames.forEach(function (full) {
          if (nameMatch(dbLiaison, full)) {
            duties.push({block: 'annual', icon: 'volunteer', text: 'Cleaning Crew Liaison', detail: 'Facility Committee &middot; Year-long', popup: {type: 'committee', name: 'Facility Committee'}, manage: 'cleaningCrew'});
          }
        });
      }
    }
    SPECIAL_EVENTS.forEach(function (ev) {
      var isCoord = ev.coordinator && parentFullNames.some(function(full) {
        return ev.coordinator.indexOf(fam.parents.split(' & ')[0].split(' ')[0]) !== -1;
      });
      if (isCoord) {
        var statusClass = ev.status === 'Complete' ? 'mf-status-done' : ev.status === 'Needs Volunteers' ? 'mf-status-open' : 'mf-status-upcoming';
        duties.push({block: 'annual', icon: 'event', text: ev.name + ' Coordinator', detail: ev.date + ' &middot; <span class="' + statusClass + '">' + ev.status + '</span>', popup: {type: 'event', name: ev.name}});
      }
    });

    // ── Personalized hero subtitle ──
    // Surface the most actionable thing for this family in plain English so
    // the hero isn't a static banner. We lead with the single most
    // noteworthy duty for the current session, then tack on a count of
    // "plus N more" plus the next co-op day.
    (function setActionableSubtitle() {
      var subtitleEl = document.getElementById('dashboardSubtitle');
      if (!subtitleEl) return;
      var sessionDuties = duties.filter(function (d) { return d.block !== 'annual'; });
      var nextDate = typeof getNextCoopDate === 'function' ? getNextCoopDate() : '';
      var dateLabel = '';
      if (nextDate && typeof formatDateLabel === 'function') {
        dateLabel = formatDateLabel(nextDate).replace(/^\w+,\s*/, '');
      }
      if (sessionDuties.length === 0) {
        var annual = duties.filter(function (d) { return d.block === 'annual'; });
        if (annual.length > 0) {
          subtitleEl.textContent = 'Session ' + currentSession + ' \u2014 nothing scheduled this session. Thanks for serving as ' + annual[0].text + '.';
        } else {
          subtitleEl.textContent = 'Session ' + currentSession + ' \u2014 no responsibilities scheduled. Your schedule is below.';
        }
        return;
      }
      var cleaningDuties = sessionDuties.filter(function (d) { return d.icon === 'clean'; });
      var teachDuties = sessionDuties.filter(function (d) { return d.icon === 'teach'; });
      var assistDuties = sessionDuties.filter(function (d) { return d.icon === 'assist'; });
      var primary = '';
      if (cleaningDuties.length) {
        primary = "You're on cleaning crew this session";
      } else if (teachDuties.length) {
        primary = "You're leading " + teachDuties[0].text.split(' \u2014 ')[0];
      } else if (assistDuties.length) {
        primary = "You're assisting with " + assistDuties[0].text.split(' \u2014 ')[0];
      } else {
        primary = "You have " + sessionDuties.length + " " + (sessionDuties.length === 1 ? 'responsibility' : 'responsibilities') + ' this session';
      }
      var extraCount = sessionDuties.length - (cleaningDuties.length ? 0 : 1);
      var extra = '';
      if (!cleaningDuties.length && extraCount > 0) {
        extra = ' + ' + extraCount + ' more';
      } else if (cleaningDuties.length && sessionDuties.length > cleaningDuties.length) {
        extra = ' + ' + (sessionDuties.length - cleaningDuties.length) + ' more';
      }
      var datePart = dateLabel ? ' \u00b7 Next co-op day: ' + dateLabel : '';
      subtitleEl.textContent = primary + extra + datePart + '.';
    })();

    // ── Render by section ──
    var blockOrder = ['AM', 'PM1', 'PM2'];
    if (hasCleaning) blockOrder.push('Cleaning');
    blockOrder.push('annual');

    var blockLabels = { AM: 'AM (10:00\u201312:00)', PM1: 'PM Hour 1 (1:00\u20131:55)', PM2: 'PM Hour 2 (2:00\u20132:55)', Cleaning: 'Cleaning', annual: 'Annual Roles' };

    // Helper to render a single duty row
    function renderDutyRow(d, globalIdx) {
      var classKey = getClassKey(d);
      var isTeacher = d.icon === 'teach';
      var hasRoleDesc = !!(getRoleKeyForDuty(d.text) && getRoleByKey(getRoleKeyForDuty(d.text)));
      var isClickable = d.popup || hasRoleDesc;
      var h = '<div class="mf-duty' + (isClickable ? ' mf-duty-clickable' : '') + '" data-duty-idx="' + globalIdx + '"' + (isClickable ? ' style="cursor:pointer;"' : '') + '>';
      h += '<div class="mf-duty-icon">' + (DUTY_ICONS[d.icon] || '') + '</div>';
      h += '<div class="mf-duty-info"><strong>' + d.text + '</strong><span>' + d.detail + '</span>';
      if (classKey && (isTeacher || d.icon === 'assist')) {
        h += '<div class="mf-duty-link-area" data-class-key="' + classKey + '" data-is-teacher="' + (isTeacher ? '1' : '0') + '"></div>';
      }
      h += '</div>';
      // Right-aligned actions area
      h += '<div class="mf-duty-actions">';
      if (d.manage) {
        h += '<button class="mf-manage-btn" data-manage="' + d.manage + '">';
        h += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
        h += ' Manage</button>';
      }
      if (d.isCoverage && d.slotId) {
        h += '<button class="sc-btn sc-btn-del mf-duty-cancel-cover" data-slot-id="' + d.slotId + '" title="Cancel covering this slot">Cancel</button>';
      } else if (d.popup && !d.manage) {
        h += '<div class="mf-duty-arrow">&rsaquo;</div>';
      }
      h += '</div>';
      h += '</div>';
      return h;
    }

    if (duties.length === 0) {
      html += '<p class="mf-empty">No assignments found for this session.</p>';
    } else {
      // Compact summary in card — show count per block + first duty of each
      html += '<div class="mf-duties-summary">';
      blockOrder.forEach(function (blk) {
        var blockDuties = duties.filter(function (d) { return d.block === blk; });
        if (blockDuties.length === 0) return;
        html += '<div class="mf-block-section"><div class="mf-block-label">' + blockLabels[blk] + '</div>';
        blockDuties.forEach(function (d) {
          html += renderDutyRow(d, duties.indexOf(d));
        });
        html += '</div>';
      });
      html += '</div>';
    }
    // Coverage notes area (populated after absences load)
    html += '<div id="coverageNotesArea" class="coverage-notes-area"></div>';
    // "I'll Be Out" button
    html += '<button class="btn btn-absence" id="reportAbsenceBtn" data-has-cleaning="' + (hasCleaning ? '1' : '0') + '">I\'ll Be Out</button>';
    // My absences area (populated after absences load)
    html += '<div id="myAbsencesArea"></div>';
    html += '</div>';

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
      html += '<div class="mf-kid-photo" style="background:' + faceColor(kid.name) + '">' + kidAvatarInnerHtml(kid.name, fam.email, fam.name) + '</div>';
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

    // ──── Billing card ────
    html += '<div class="mf-card mf-billing-card">';
    html += '<h3 class="mf-card-title">Billing &amp; Fees</h3>';

    var semKeys = ['fall', 'spring'];

    // Track whether anything actually rendered so we can show a placeholder
    // when both Fall and Spring are gated out (e.g. an unregistered family
    // in April–Oct of a deposit-only year).
    var anySemRendered = false;

    // ── Each semester: deposit then fees ──
    semKeys.forEach(function (semKey) {
      var sem = calculateSemesterFees(fam, semKey);
      if (!sem) return;
      if (!sem.visible) return;
      anySemRendered = true;

      // Membership fee subsection (the $50 that was previously labeled "deposit" —
      // this is what the public registration flow collects at sign-up). PayPal
      // charges us a per-transaction fee on every payment, so we add it on top
      // of the $50 here rather than absorbing it.
      if (sem.deposit) {
        var depPaid = sem.depositStatus === 'Paid';
        var depPending = sem.depositStatus === 'Pending';
        var depStatusClass = depPaid ? 'mf-billing-paid'
          : depPending ? 'mf-billing-pending' : 'mf-billing-due-status';
        html += '<div class="mf-billing-semester">';
        html += '<div class="mf-billing-header">';
        html += '<strong>' + sem.name + ' Membership Fee</strong>';
        html += '<span class="mf-billing-status ' + depStatusClass + '">' + sem.depositStatus + '</span>';
        html += '</div>';
        html += '<div class="mf-billing-lines">';
        html += '<div class="mf-billing-line">';
        html += '<span>Membership Fee (per family)</span>';
        html += '<span>$' + sem.deposit.toFixed(2) + '</span>';
        html += '</div>';
        if (!depPaid && sem.depositPaypalFee) {
          html += '<div class="mf-billing-line mf-billing-fee-line">';
          html += '<span>Processing fee</span>';
          html += '<span>$' + sem.depositPaypalFee.toFixed(2) + '</span>';
          html += '</div>';
        }
        var depBottomLabel = depPaid ? 'Amount paid'
          : depPending ? 'Payment submitted' : 'Balance due';
        var depBottomAmount = depPaid ? sem.deposit : sem.depositTotal;
        html += '<div class="mf-billing-line mf-billing-balance">';
        html += '<span>' + depBottomLabel + '</span>';
        html += '<span>$' + depBottomAmount.toFixed(2) + '</span>';
        html += '</div>';
        html += '</div>';
        if (!depPaid) {
          html += '<p class="mf-billing-fee-note">PayPal charges a per-transaction processing fee on every payment. We add it here so the full $' + sem.deposit.toFixed(0) + ' membership fee reaches the co-op.</p>';
        }
        if (depPending) {
          html += '<div class="mf-billing-pending-note">Payment received — awaiting Treasurer confirmation.</div>';
        } else if (!depPaid) {
          var depBtnId = 'paypal-dep-' + semKey;
          html += '<div class="mf-billing-pay-wrap">';
          html += '<button class="mf-billing-pay-btn" id="' + depBtnId + '">';
          html += '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
          html += ' Pay $' + sem.depositTotal.toFixed(2) + '</button>';
          html += '</div>';
        }
        html += '</div>';
      }

      // Semester fees subsection — hidden for years where the board has
      // chosen to surface only the membership/deposit fee (e.g. 2026-27
      // per BILLING_CONFIG.semesters[*].showClassFees). The deposit
      // subsection above already self-closed its container.
      if (!sem.showClassFees) return;
      var isPaid = sem.status === 'Paid';
      var isPending = sem.status === 'Pending';
      var statusClass = isPaid ? 'mf-billing-paid'
        : isPending ? 'mf-billing-pending' : 'mf-billing-due-status';
      var dueStr = new Date(sem.dueDate + 'T00:00:00').toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric'});

      html += '<div class="mf-billing-semester">';
      html += '<div class="mf-billing-header">';
      html += '<strong>' + sem.name + ' Class Fees</strong>';
      html += '<span class="mf-billing-status ' + statusClass + '">' + sem.status + '</span>';
      html += '</div>';
      html += '<div class="mf-billing-due">Due: ' + dueStr + '</div>';
      html += '<div class="mf-billing-lines">';

      // Consolidated line items
      var programmingKids = fam.kids.filter(function(k) { return k.group !== 'Greenhouse'; });
      var fullDayKids = programmingKids.filter(function(k) { return !k.schedule || k.schedule === 'all-day'; });
      var nSessions = sem.sessionCount;

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

      // Processing fee (only relevant for unpaid balances)
      if (!isPaid) {
        html += '<div class="mf-billing-line mf-billing-fee-line">';
        html += '<span>Processing fee</span>';
        html += '<span>$' + sem.paypalFee.toFixed(2) + '</span>';
        html += '</div>';
      }

      // Bottom line: relabel to match status so Paid families don't see
      // a confusing "Balance due" next to a Paid badge.
      var bottomLabel = isPaid ? 'Amount paid'
        : isPending ? 'Payment submitted' : 'Balance due';
      var bottomAmount = isPaid ? sem.subtotal : sem.total;
      html += '<div class="mf-billing-line mf-billing-balance">';
      html += '<span>' + bottomLabel + '</span>';
      html += '<span>$' + bottomAmount.toFixed(2) + '</span>';
      html += '</div>';
      html += '</div>';

      // Pay button (only if not paid or pending)
      if (isPending) {
        html += '<div class="mf-billing-pending-note">Payment received — awaiting Treasurer confirmation.</div>';
      } else if (!isPaid) {
        var paypalContainerId = 'paypal-btn-' + semKey;
        html += '<div class="mf-billing-pay-wrap">';
        html += '<button class="mf-billing-pay-btn" id="' + paypalContainerId + '">';
        html += '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
        html += ' Pay $' + sem.total.toFixed(2) + '</button>';
        html += '</div>';
      }

      html += '</div>';
    });
    if (!anySemRendered) {
      html += '<p class="mf-billing-empty">Nothing to bill right now. ' +
        'Once you register for ' + ACTIVE_YEAR.label + ', your Fall membership ' +
        'fee will appear here.</p>';
    }
    html += '<div class="mf-billing-footer">';
    html += '<p>Also accepted: check payable to <em>' + BILLING_CONFIG.checkPayableTo + '</em>, deliver to ' + BILLING_CONFIG.checkDeliverTo + '</p>';
    html += '<p class="mf-billing-contact">Questions? <a href="mailto:treasurer@rootsandwingsindy.com">treasurer@rootsandwingsindy.com</a></p>';
    html += '</div>';
    html += '</div>';

    // PM class submissions — member-authored ideas for upcoming PM electives.
    // Card is always visible; body is populated by renderClassSubsCardBody()
    // after loadMyClassSubmissions() fills `myClassSubmissions`.
    html += '<div class="mf-card mf-classsubs-card" id="mfClassSubsCard">';
    html += '<h3 class="mf-card-title">PM Class Submissions</h3>';
    html += '<p class="mf-card-subtitle" style="color:var(--color-text-light);font-size:0.9rem;margin:0 0 1rem;">';
    html += 'Have an idea for an afternoon class? Propose it here and the VP + Afternoon Class Liaison will reach out when planning the next session.';
    html += '</p>';
    html += '<div class="mf-classsubs-body" id="mfClassSubsBody"><em style="color:var(--color-text-light);">Loading…</em></div>';
    html += '</div>';

    grid.innerHTML = html;
    section.style.display = '';

    // Keep the header picker in sync with the active family.
    renderHeaderViewAs();

    // "Back to my view" button from the impersonation banner.
    var viewAsReset = document.getElementById('viewAsReset');
    if (viewAsReset) {
      viewAsReset.onclick = function () {
        sessionStorage.removeItem(VIEW_AS_KEY);
        renderMyFamily();
        if (typeof renderCoordinationTabs === 'function') renderCoordinationTabs();
        if (typeof loadNotifications === 'function') loadNotifications();
        if (typeof renderWorkspaceTab === 'function') renderWorkspaceTab();
      };
    }

    // Wire up duty detail popups
    grid.querySelectorAll('.mf-duty-clickable').forEach(function (row) {
      row.addEventListener('click', function (e) {
        // Don't trigger detail if Manage button, Cancel button, or info button was clicked
        if (e.target.closest('.mf-manage-btn')) return;
        if (e.target.closest('.mf-duty-cancel-cover')) return;
        var idx = parseInt(this.getAttribute('data-duty-idx'), 10);
        if (duties[idx]) showDutyDetail(duties[idx]);
      });
    });

    // Wire up Cancel-covering buttons inside My Responsibilities
    grid.querySelectorAll('.mf-duty-cancel-cover').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!confirm('Cancel your coverage for this slot? It will go back to Needs Coverage.')) return;
        var slotId = parseInt(this.getAttribute('data-slot-id'), 10);
        this.disabled = true;
        var origText = this.textContent;
        this.textContent = 'Cancelling\u2026';
        var self = this;
        var cred = localStorage.getItem('rw_google_credential');
        fetch('/api/coverage?id=' + slotId, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + cred }
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (!res.ok) {
            alert('Error: ' + (res.data.error || 'cancel failed'));
            self.disabled = false; self.textContent = origText; return;
          }
          loadCoverageBoard();
          if (typeof loadNotifications === 'function') loadNotifications();
        });
      });
    });

    // Wire up Manage buttons
    grid.querySelectorAll('.mf-manage-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var type = this.getAttribute('data-manage');
        if (type === 'cleaningCrew') showCleaningManagementModal();
        if (type === 'supplyCloset') showSupplyClosetPopup();
      });
    });

    // Wire up "View Class" buttons — opens the AM class detail modal
    // (same popup used for duties), giving a focused view of the class's
    // teacher, topic, and students rather than dumping the user into
    // the full Directory filtered view. Normalize "Teens" → "Pigeons"
    // because AM_CLASSES is keyed by the canonical name.
    grid.querySelectorAll('.mf-class-link').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var group = this.getAttribute('data-group');
        var lookup = group === 'Teens' ? 'Pigeons' : group;
        showDutyDetail({ popup: { type: 'amClass', group: lookup, session: currentSession } });
      });
    });

    // Wire up elective detail links
    grid.querySelectorAll('.mf-elective-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var elecName = this.getAttribute('data-elective');
        showElectiveDetail(elecName);
      });
    });

    // Wire up "I'll Be Out" button
    var absenceBtn = grid.querySelector('#reportAbsenceBtn');
    if (absenceBtn) {
      absenceBtn.addEventListener('click', showAbsenceModal);
    }

    // Render data that may already be loaded from async fetches.
    // Re-render the coverage board so it survives renderMyFamily() being
    // called again by loadCleaningData / loadRoleDescriptions / loadLiveData —
    // those swap grid.innerHTML, which destroys #coverageBoardCard. We always
    // call this (even with an empty array) so the VP's empty-state card
    // survives re-renders too.
    renderCoverageBoard(loadedAbsences || []);
    if (Object.keys(classLinks).length > 0) {
      updateClassLinkButtons();
    }
    // Repopulate the PM class submissions card from already-fetched state.
    // renderMyFamily is called many times per session (on login, after sheets
    // load, after billing loads, etc.) — without this, every re-render leaves
    // the card stuck on its "Loading…" placeholder.
    if (typeof renderClassSubsCardBody === 'function') {
      renderClassSubsCardBody();
    }
    // Refresh the personal participation badge in the greeting. Internally
    // caches by active email, so re-renders are cheap.
    if (typeof loadParticipationBadge === 'function') loadParticipationBadge();

    // Build PayPal note with family details
    function buildPaypalNote(fam, semKey, paymentType) {
      var sem = BILLING_CONFIG.semesters[semKey];
      var semesterNum = semKey === 'fall' ? '1' : '2';
      var programmingKids = fam.kids.filter(function(k) { return k.group !== 'Greenhouse'; });
      var numKids = programmingKids.length;

      // Determine schedule: AM, PM, or Both
      var hasAM = false;
      var hasPM = false;
      programmingKids.forEach(function(k) {
        var sched = k.schedule || 'all-day';
        if (sched === 'all-day' || sched === 'morning') hasAM = true;
        if (sched === 'all-day' || sched === 'afternoon') hasPM = true;
      });
      var schedule = (hasAM && hasPM) ? 'Both' : hasAM ? 'AM' : 'PM';

      return fam.name + ' family | ' + numKids + (numKids === 1 ? ' kid' : ' kids') +
        ' | ' + schedule + ' | Semester ' + semesterNum + ' (Sessions ' + sem.sessions.join(', ') + ') | ' + paymentType;
    }

    // Record a Pending payment to /api/sheets?action=billing so the UI can
    // show "Pending" until the Treasurer marks the row Paid in the sheet.
    function recordPendingPayment(familyName, semKey, paymentType, paypalId, amount, payerEmail) {
      var googleCred = localStorage.getItem('rw_google_credential');
      if (!googleCred) return Promise.resolve();
      return fetch('/api/sheets?action=billing', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + googleCred,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          family_name: familyName,
          semester_key: semKey,
          payment_type: paymentType,
          school_year: ACTIVE_YEAR.label,
          paypal_transaction_id: paypalId || '',
          amount_cents: Math.round((parseFloat(amount) || 0) * 100),
          payer_email: payerEmail || ''
        })
      }).catch(function (e) {
        console.warn('[billing] recordPendingPayment failed:', e);
      });
    }

    // Wire up PayPal pay buttons (semester fees + deposits)
    function wirePaypalButton(btnId, amount, description, invoiceId, email, note, semKey, paymentType) {
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
                custom_id: email,
                note_to_payee: note
              }]
            });
          },
          onApprove: function (data, actions) {
            return actions.order.capture().then(function (details) {
              var wrap = btn.closest('.mf-billing-pay-wrap');
              wrap.innerHTML = '<div class="mf-billing-success">Payment complete! Transaction ID: ' + details.id + '</div>';
              // Record Pending in our DB so the UI flips to "Pending" on next load.
              recordPendingPayment(fam.name, semKey, paymentType, details.id, amount, email)
                .then(function () { loadBillingStatus(function () { renderMyFamily(); }); });
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
      if (!sem || !sem.visible) return;
      var capKey = semKey.charAt(0).toUpperCase() + semKey.slice(1);
      var year = new Date().getFullYear();
      // Each of the four payments identifies its type in description, invoice_id,
      // and note_to_payee so the treasurer can reconcile without guessing.
      wirePaypalButton('paypal-dep-' + semKey, sem.depositTotal.toFixed(2),
        sem.name + ' Membership Fee — ' + fam.name + ' family',
        'RW-' + capKey + '-Memb-' + fam.name + '-' + year, fam.email,
        buildPaypalNote(fam, semKey, sem.name + ' Membership Fee'),
        semKey, 'deposit');
      wirePaypalButton('paypal-btn-' + semKey, sem.total.toFixed(2),
        sem.name + ' Class Fees — ' + fam.name + ' family',
        'RW-' + capKey + '-Classes-' + fam.name + '-' + year, fam.email,
        buildPaypalNote(fam, semKey, sem.name + ' Class Fees'),
        semKey, 'class_fee');
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
    var leaderPerson = lookupPerson(elec.leader);
    var leaderEmail = leaderPerson ? leaderPerson.email : '';
    var leaderFamily = leaderPerson ? leaderPerson.family : '';
    html += '<div class="elective-teacher">';
    html += '<div class="staff-dot" style="background:' + faceColor(elec.leader) + ';width:36px;height:36px;overflow:hidden;">' + photoHtml(elec.leader, elec.leader, leaderEmail, leaderFamily) + '</div>';
    html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + elec.leader + pronounTag(leaderPerson) + '</strong><small style="color:var(--color-text-light);">Leader</small></div>';
    html += '</div>';
    if (elec.assistants && elec.assistants.length > 0) {
      elec.assistants.forEach(function (a) {
        var assistPerson = lookupPerson(a);
        var aEmail = assistPerson ? assistPerson.email : '';
        var aFamily = assistPerson ? assistPerson.family : '';
        html += '<div class="elective-teacher">';
        html += '<div class="staff-dot" style="background:' + faceColor(a) + ';width:36px;height:36px;overflow:hidden;">' + photoHtml(a, a, aEmail, aFamily) + '</div>';
        html += '<div class="staff-label" style="color:var(--color-text);"><strong style="color:var(--color-text);">' + a + pronounTag(assistPerson) + '</strong><small style="color:var(--color-text-light);">Assistant</small></div>';
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
    // Allergy / medical alerts surface BEFORE the roster so they're visible
    // without scrolling on smaller modals.
    html += studentAllergyCallout(elec.students);
    html += '<div class="elective-roster">';
    elec.students.forEach(function (kidName) {
      var first = kidName.split(' ')[0];
      var last = kidName.split(' ').slice(1).join(' ');
      var kidPerson = lookupPerson(kidName);
      var kidEmail = kidPerson ? kidPerson.email : '';
      var kidFamily = kidPerson ? kidPerson.family : last;
      var optedOut = kidPerson && kidPerson.photoConsent === false;
      var noPhoto = optedOut ? ' <span class="elective-student-nophoto" title="Opted out of photo and film">⛔ No Photos</span>' : '';
      html += '<div class="elective-student' + (optedOut ? ' elective-student-nophoto-card' : '') + '">';
      html += '<div class="elective-student-dot" style="background:' + faceColor(first) + '">' + kidAvatarInnerHtml(kidName, kidEmail, kidFamily) + '</div>';
      html += '<div><strong>' + first + '</strong> <span class="elective-student-last">' + last + '</span>' + pronounTag(kidPerson) + noPhoto + '</div>';
      html += '</div>';
    });
    html += '</div>';

    // Append role description for leader/assistant
    var activeEmail = getActiveEmail();
    var activeFam = null;
    for (var fi = 0; fi < FAMILIES.length; fi++) { if (familyMatchesEmail(FAMILIES[fi], activeEmail)) { activeFam = FAMILIES[fi]; break; } }
    if (activeFam) {
      var myFullNames = activeFam.parents.split(' & ').map(function(pp) { return pp.trim() + ' ' + activeFam.name; });
      var isLeader = myFullNames.some(function(fn) { return fn.toLowerCase() === (elec.leader || '').trim().toLowerCase(); });
      var isAssist = (elec.assistants || []).some(function(a) { return myFullNames.some(function(fn) { return fn.toLowerCase() === a.trim().toLowerCase(); }); });
      if (isLeader) html += renderRoleDescriptionSection('classroom_instructor');
      else if (isAssist) html += renderRoleDescriptionSection('classroom_assistant');
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

  // Highlight names matching the current user in coordination tabs
  function getMyNames() {
    var email = getActiveEmail();
    if (!email || !FAMILIES) return { fullNames: [], familyName: '' };
    var fam = null;
    for (var i = 0; i < FAMILIES.length; i++) { if (familyMatchesEmail(FAMILIES[i], email)) { fam = FAMILIES[i]; break; } }
    if (!fam) return { fullNames: [], familyName: '' };
    return {
      fullNames: fam.parents.split(' & ').map(function (p) { return p.trim() + ' ' + fam.name; }),
      familyName: fam.name
    };
  }

  function highlightIfMe(name, myNames) {
    if (!name || !myNames) return name;
    var lower = name.trim().toLowerCase();
    var match = false;
    if (myNames.fullNames) {
      myNames.fullNames.forEach(function (fn) { if (fn.toLowerCase() === lower) match = true; });
    }
    if (myNames.familyName && lower === myNames.familyName.toLowerCase()) match = true;
    return match ? '<span class="coord-highlight">' + name + '</span>' : name;
  }

  function highlightFamilyIfMe(familyName, myNames) {
    if (!familyName || !myNames || !myNames.familyName) return familyName;
    return familyName.trim().toLowerCase() === myNames.familyName.toLowerCase()
      ? '<span class="coord-highlight">' + familyName + '</span>'
      : familyName;
  }

  function renderSessionTab() {
    var container = document.getElementById('sessionTabContent');
    if (!container) return;
    var viewSess = sessionTabView;
    var sess = SESSION_DATES[viewSess];
    var electives = PM_ELECTIVES[viewSess] || [];

    var html = buildSessionPager(viewSess, 'session');

    // Morning classes table
    var myNames = getMyNames();
    html += '<h4 class="session-section-title">Morning Classes &mdash; 10:00\u201312:00</h4>';
    html += '<div class="directory-table-wrap"><table class="portal-table"><thead><tr><th>Group</th><th>Ages</th><th>Topic</th><th>Leader</th><th>Assistants</th><th>Room</th></tr></thead><tbody>';
    var groups = Object.keys(AM_CLASSES);
    groups.forEach(function (groupName) {
      var cls = AM_CLASSES[groupName];
      var s = cls.sessions[viewSess];
      if (!s) return;
      var isMyRow = myNames.fullNames.some(function (fn) { var l = fn.toLowerCase(); return l === s.teacher.trim().toLowerCase() || (s.assistants || []).some(function (a) { return a.trim().toLowerCase() === l; }); });
      var assistantsHtml = (s.assistants || []).map(function (a) { return highlightIfMe(a, myNames); }).join(', ') || '\u2014';
      html += '<tr class="session-class-row' + (isMyRow ? ' coord-my-row' : '') + '" data-group="' + groupName + '">';
      html += '<td><span class="session-group-link">' + groupName + '</span></td>';
      html += '<td>' + cls.ages + '</td>';
      html += '<td>' + s.topic + '</td>';
      html += '<td>' + highlightIfMe(s.teacher, myNames) + '</td>';
      html += '<td>' + assistantsHtml + '</td>';
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
      hour1.forEach(function (e) { html += buildElectiveCard(e, myNames); });
      html += '</div>';

      html += '<h4 class="session-section-title">Afternoon Electives &mdash; Hour 2: 2:00\u20132:55</h4>';
      html += '<div class="elective-card-grid">';
      hour2.forEach(function (e) { html += buildElectiveCard(e, myNames); });
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

    // Wire up full row clicks → open the AM class detail modal for that group
    container.querySelectorAll('.session-class-row').forEach(function (row) {
      row.onclick = function () {
        var group = this.getAttribute('data-group');
        showDutyDetail({ popup: { type: 'amClass', group: group, session: currentSession } });
      };
    });
  }

  function buildElectiveCard(e, myNames) {
    var pct = Math.round((e.students.length / e.maxCapacity) * 100);
    var barColor = pct >= 90 ? 'var(--color-error)' : pct >= 70 ? 'var(--color-accent)' : 'var(--color-primary-light)';
    var isMyCard = myNames && myNames.fullNames.some(function (fn) { var l = fn.toLowerCase(); return l === (e.leader || '').trim().toLowerCase() || (e.assistants || []).some(function (a) { return a.trim().toLowerCase() === l; }); });
    var html = '<button class="elective-card' + (isMyCard ? ' coord-my-card' : '') + '" data-elective="' + e.name + '">';
    html += '<div class="elective-card-header">';
    html += '<span class="elective-card-name">' + e.name + '</span>';
    html += '<span class="elective-age-pill">' + e.ageRange + '</span>';
    html += '</div>';
    if (e.hour === 'both') html += '<span class="elective-both-badge">Both Hours</span>';
    html += '<p class="elective-card-desc">' + e.description + '</p>';
    var leaderHtml = myNames ? highlightIfMe(e.leader, myNames) : e.leader;
    var assistHtml = (e.assistants && e.assistants.length > 0) ? ' + ' + e.assistants.map(function (a) { return myNames ? highlightIfMe(a, myNames) : a; }).join(', ') : '';
    html += '<div class="elective-card-meta">' + e.room + ' &middot; ' + leaderHtml + assistHtml + '</div>';
    html += '<div class="elective-capacity-bar"><div class="elective-capacity-fill" style="width:' + pct + '%;background:' + barColor + '"></div></div>';
    html += '<div class="elective-card-spots">' + e.students.length + '/' + e.maxCapacity + '</div>';
    html += '</button>';
    return html;
  }

  function cleaningApiCall(method, params, body) {
    var googleCred = localStorage.getItem('rw_google_credential');
    var url = '/api/cleaning' + (params ? '?' + params : '');
    var opts = { method: method, headers: { 'Authorization': 'Bearer ' + googleCred, 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(function (r) { return r.json(); });
  }

  function findAreaId(floorKey, areaName) {
    for (var i = 0; i < cleaningDB.areas.length; i++) {
      if (cleaningDB.areas[i].floor_key === floorKey && cleaningDB.areas[i].area_name === areaName) return cleaningDB.areas[i].id;
    }
    return null;
  }

  // Map a stored family_name to its full display string ("Jody Wilson"
  // instead of just "Wilson"). Looks up a matching family in the live
  // directory by exact last-name match, falling back to the stored value
  // unchanged so that already-full names or unmatched typed values still
  // render cleanly.
  function cleaningDisplayName(stored) {
    var raw = String(stored || '').trim();
    if (!raw) return '';
    // If the stored value already has a space, it's already a full name.
    if (raw.indexOf(' ') !== -1) return raw;
    var lower = raw.toLowerCase();
    for (var i = 0; i < (FAMILIES || []).length; i++) {
      var f = FAMILIES[i];
      if (f && f.name && f.name.toLowerCase() === lower) {
        var full = ((f.parents || '').trim() + ' ' + f.name).trim();
        return full || raw;
      }
    }
    return raw;
  }

  // Reusable parent picker source. Returns one entry per parent across all
  // FAMILIES, sorted by family name. Each entry has the derived Workspace
  // email (firstname + family-last-initial @ domain — same convention used
  // by api/sheets.js parseDirectory and scripts/seed-role-holders.js), plus
  // a person_name / family_name pair ready to POST to role_holders or any
  // other table that stores an individual.
  //
  // Skips families with only a family name (no parent first names) and
  // any "parents" entry that isn't a real word — defensive against the
  // odd directory row.
  function buildParentPickerOptions() {
    var opts = [];
    (FAMILIES || []).forEach(function (fam) {
      if (!fam || !fam.name || !fam.parents) return;
      var familyLast = String(fam.name).trim();
      if (!familyLast) return;
      var lastInitial = familyLast.charAt(0).toLowerCase();
      String(fam.parents).split(/\s*&\s*/).forEach(function (firstRaw) {
        var first = String(firstRaw || '').trim();
        if (!first) return;
        var firstClean = first.replace(/[^A-Za-z]/g, '');
        if (!firstClean) return;
        var email = firstClean.toLowerCase() + lastInitial + '@rootsandwingsindy.com';
        opts.push({
          email: email,
          person_name: first + ' ' + familyLast,
          family_name: familyLast,
          displayName: first + ' ' + familyLast,
          sortKey: (familyLast + ' ' + first).toLowerCase()
        });
      });
    });
    opts.sort(function (a, b) { return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0; });
    return opts;
  }

  // Pre-seed the DB with every sheet-derived assignment for a session so that
  // applyCleaningData() no longer wipes the rest of the chips when the next
  // fetch returns a single-row DB view. Idempotent-ish: if the DB already has
  // any assignments for this session we skip the seed. Returns a Promise.
  function ensureSessionSeeded(sessionNumber) {
    sessionNumber = parseInt(sessionNumber, 10);
    if (!sessionNumber) return Promise.resolve();

    var hasDB = (cleaningDB.assignments || []).some(function (a) {
      return a.session_number === sessionNumber;
    });
    if (hasDB) return Promise.resolve();

    var sess = CLEANING_CREW && CLEANING_CREW.sessions && CLEANING_CREW.sessions[sessionNumber];
    if (!sess) return Promise.resolve();

    var posts = [];
    ['mainFloor', 'upstairs', 'outside'].forEach(function (floor) {
      var floorData = sess[floor] || {};
      Object.keys(floorData).forEach(function (areaName) {
        var areaId = findAreaId(floor, areaName);
        if (!areaId) return;
        (floorData[areaName] || []).forEach(function (familyName) {
          if (familyName) posts.push({ session_number: sessionNumber, cleaning_area_id: areaId, family_name: familyName });
        });
      });
    });
    if (Array.isArray(sess.floater)) {
      var floaterId = findAreaId('floater', 'Floater');
      if (floaterId) {
        sess.floater.forEach(function (familyName) {
          if (familyName) posts.push({ session_number: sessionNumber, cleaning_area_id: floaterId, family_name: familyName });
        });
      }
    }

    if (posts.length === 0) return Promise.resolve();

    // Serialize the seeds so a transient error doesn't leave the DB
    // half-populated for the session. (Parallel would be faster but the
    // data set is tiny — ~15 rows at most.)
    return posts.reduce(function (chain, body) {
      return chain.then(function () { return cleaningApiCall('POST', 'action=assignment', body); });
    }, Promise.resolve()).then(function () {
      // Refresh local cleaningDB so subsequent findAssignmentId calls work.
      return fetch('/api/cleaning', {
        headers: { 'Authorization': 'Bearer ' + localStorage.getItem('rw_google_credential') }
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data && !data.error) applyCleaningData(data);
      });
    });
  }

  // Given a chip's delete button, infer which floor/area the chip lives in by
  // walking up the rendered DOM (chips sit inside .cle-family-chips which sits
  // inside .clm-area). The floor label is rendered as the section heading.
  function findFloorForFamilyChip(chipBtn) {
    var area = chipBtn.closest('.clm-area');
    if (!area) return null;
    var section = area.closest('.clm-floor-section');
    if (!section) return null;
    var heading = section.querySelector('h4');
    var label = heading ? heading.textContent.trim() : '';
    if (label === 'Main Floor') return 'mainFloor';
    if (label === 'Upstairs') return 'upstairs';
    if (label === 'Outside') return 'outside';
    if (label === 'Floater') return 'floater';
    return null;
  }

  function findAreaForFamilyChip(chipBtn, floorKey) {
    if (floorKey === 'floater') return 'Floater';
    var area = chipBtn.closest('.clm-area');
    if (!area) return null;
    var nameEl = area.querySelector('.clm-area-name');
    return nameEl ? nameEl.textContent.trim() : null;
  }

  function findAreaTasks(floorKey, areaName) {
    for (var i = 0; i < cleaningDB.areas.length; i++) {
      if (cleaningDB.areas[i].floor_key === floorKey && cleaningDB.areas[i].area_name === areaName) return cleaningDB.areas[i].tasks || [];
    }
    return [];
  }

  function findAssignmentId(session, floorKey, areaName, familyName) {
    for (var i = 0; i < cleaningDB.assignments.length; i++) {
      var a = cleaningDB.assignments[i];
      if (a.session_number === session && a.floor_key === floorKey && a.area_name === areaName && a.family_name === familyName) return a.id;
    }
    return null;
  }

  function renderCleaningTab() {
    var container = document.getElementById('cleaningTabContent');
    if (!container) return;
    var viewSess = cleaningTabView;
    var sessClean = CLEANING_CREW.sessions[viewSess];

    var html = buildSessionPager(viewSess, 'cleaning');
    var liaisonLabel = getRoleByKey('cleaning_crew_liaison') ? '<a class="rd-role-link" data-role-key="cleaning_crew_liaison" href="#" onclick="return false;">Liaison</a>' : 'Liaison';
    html += '<p style="color:var(--color-text-light);margin-bottom:16px;">' + liaisonLabel + ': <strong>' + CLEANING_CREW.liaison + '</strong></p>';

    if (!sessClean) {
      html += '<p style="color:var(--color-text-light);"><em>Cleaning assignments not yet available for this session.</em></p>';
      container.innerHTML = html;
      wirePager(container);
      wireCleaningTabInfoButtons(container);
      return;
    }

    var floors = [
      { key: 'mainFloor', label: 'Main Floor' },
      { key: 'upstairs', label: 'Upstairs' },
      { key: 'outside', label: 'Outside' }
    ];

    var myNames = getMyNames();
    html += '<div class="cleaning-grid">';
    floors.forEach(function (floor) {
      if (!sessClean[floor.key]) return;
      html += '<div class="cleaning-floor-card">';
      html += '<h4>' + floor.label + '</h4>';
      var areas = Object.keys(sessClean[floor.key]);
      areas.forEach(function (area) {
        var families = sessClean[floor.key][area];
        var isMyArea = families.some(function (f) { return f.trim().toLowerCase() === myNames.familyName.toLowerCase(); });
        html += '<div class="cleaning-role' + (isMyArea ? ' coord-my-row' : '') + '">';
        // Area name — clickable if tasks exist
        var areaTaskCount = findAreaTasks(floor.key, area).length;
        if (areaTaskCount > 0) {
          html += '<a class="cleaning-area cleaning-area-link" data-floor="' + floor.key + '" data-area="' + area + '" href="#" onclick="return false;">' + area + '</a>';
        } else {
          html += '<span class="cleaning-area">' + area + '</span>';
        }
        html += '<span class="cleaning-families">' + families.map(function (f) { return highlightFamilyIfMe(f, myNames) + ' family'; }).join(', ') + '</span>';
        html += '</div>';
      });
      html += '</div>';
    });

    if (sessClean.floater && sessClean.floater.length > 0) {
      var isMyFloater = sessClean.floater.some(function (f) { return f.trim().toLowerCase() === myNames.familyName.toLowerCase(); });
      html += '<div class="cleaning-floor-card">';
      html += '<h4>Floater</h4>';
      html += '<div class="cleaning-role' + (isMyFloater ? ' coord-my-row' : '') + '"><span class="cleaning-families">' + sessClean.floater.map(function (f) { return highlightFamilyIfMe(f, myNames) + ' family'; }).join(', ') + '</span></div>';
      html += '</div>';
    }
    html += '</div>';

    container.innerHTML = html;
    wirePager(container);
    wireCleaningTabInfoButtons(container);
  }

  function wireCleaningTabInfoButtons(container) {
    // Role description links
    container.querySelectorAll('.rd-role-link').forEach(function (link) {
      link.onclick = function (e) {
        e.preventDefault();
        showRoleDescriptionModal(this.getAttribute('data-role-key'), false);
      };
    });
    // Cleaning area name links → task popup
    container.querySelectorAll('.cleaning-area-link').forEach(function (link) {
      link.onclick = function (e) {
        e.preventDefault();
        var floorKey = this.getAttribute('data-floor');
        var areaName = this.getAttribute('data-area');
        var tasks = findAreaTasks(floorKey, areaName);
        if (!tasks.length || !personDetail || !personDetailCard) return;
        var html = '<button class="detail-close" aria-label="Close">&times;</button>';
        html += '<div class="elective-detail">';
        html += '<h3>' + areaName + '</h3>';
        html += '<p style="color:var(--color-text-light);margin-bottom:1rem;">Cleaning tasks for this area</p>';
        html += '<ul style="margin:0;padding-left:1.5rem;font-size:0.88rem;line-height:1.7;list-style:disc;">';
        tasks.forEach(function (t) { html += '<li style="margin-bottom:4px;padding-left:4px;">' + t + '</li>'; });
        html += '</ul></div>';
        personDetailCard.innerHTML = html;
        personDetail.style.display = 'flex';
        personDetailCard.querySelector('.detail-close').onclick = function () { personDetail.style.display = 'none'; };
        personDetail.onclick = function (ev) { if (ev.target === personDetail) personDetail.style.display = 'none'; };
      };
    });
  }

  // ──────────────────────────────────────────────
  // Cleaning Management Modal (from My Responsibilities)
  // ──────────────────────────────────────────────
  var cleaningModalSession = currentSession;

  function showCleaningManagementModal() {
    if (!personDetail || !personDetailCard) return;
    if (!cleaningDB.loaded) {
      loadCleaningData();
      return;
    }
    cleaningModalSession = currentSession;
    renderCleaningModal();
  }

  function renderCleaningModal() {
    var viewSess = cleaningModalSession;
    var sessClean = CLEANING_CREW.sessions[viewSess];

    // Build the shared autocomplete list from the live directory once per
    // render. Each option is the full "<parents> <lastname>" display string
    // so what gets typed == what gets stored, and the chip shows the full
    // name without extra lookups.
    var familyOptions = '';
    var seen = {};
    (FAMILIES || []).map(function (f) {
        if (!f || !f.name) return null;
        var disp = ((f.parents || '').trim() + ' ' + f.name).trim();
        return disp;
      })
      .filter(function (n) { return !!n; })
      .sort(function (a, b) { return a.localeCompare(b); })
      .forEach(function (n) {
        var key = n.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        familyOptions += '<option value="' + escapeAttr(n) + '"></option>';
      });

    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail sc-modal">';
    html += '<datalist id="cle-families-datalist">' + familyOptions + '</datalist>';
    html += '<h3>Cleaning Crew Management</h3>';

    // Session selector
    html += '<div class="cle-modal-session-row">';
    html += '<label>Session:</label>';
    for (var s = 1; s <= 5; s++) {
      html += '<button class="cle-sess-btn' + (s === viewSess ? ' cle-sess-active' : '') + '" data-sess="' + s + '">' + s + '</button>';
    }
    html += '</div>';

    // Floor sections
    var floors = [
      { key: 'mainFloor', label: 'Main Floor' },
      { key: 'upstairs', label: 'Upstairs' },
      { key: 'outside', label: 'Outside' }
    ];

    floors.forEach(function (floor) {
      var floorAreas = cleaningDB.areas.filter(function (a) { return a.floor_key === floor.key; });
      html += '<div class="clm-floor-section">';
      html += '<h4>' + floor.label + '</h4>';

      floorAreas.forEach(function (area) {
        var families = (sessClean && sessClean[floor.key] && sessClean[floor.key][area.area_name]) || [];
        html += '<div class="clm-area">';
        html += '<div class="clm-area-header">';
        html += '<span class="clm-area-name">' + area.area_name + '</span>';
        html += '<button class="cle-tasks-toggle" data-area-id="' + area.id + '" data-floor="' + floor.key + '" data-area="' + area.area_name + '">' + (area.tasks || []).length + ' task' + ((area.tasks || []).length !== 1 ? 's' : '') + '</button>';
        html += '</div>';
        // Family chips
        html += '<div class="cle-family-chips">';
        families.forEach(function (f) {
          var aId = findAssignmentId(viewSess, floor.key, area.area_name, f);
          html += '<span class="cle-chip">' + escapeAttr(cleaningDisplayName(f)) + '<button class="cle-chip-x" data-assign-id="' + aId + '">&times;</button></span>';
        });
        html += '</div>';
        // Add volunteer input
        html += '<div class="cle-add-row">';
        html += '<input class="cle-input cle-add-input" placeholder="Add Volunteer" list="cle-families-datalist" autocomplete="off" data-area-id="' + area.id + '" data-session="' + viewSess + '">';
        html += '<button class="cle-btn cle-btn-add" data-area-id="' + area.id + '" data-session="' + viewSess + '">Add</button>';
        html += '</div>';
        // Task editor (hidden by default)
        html += '<div class="cle-tasks-editor" id="clmTasksEditor-' + area.id + '" style="display:none;"></div>';
        html += '</div>';
      });
      html += '</div>';
    });

    // Floater section
    var floaterArea = cleaningDB.areas.filter(function (a) { return a.floor_key === 'floater'; })[0];
    if (floaterArea) {
      var floaterFamilies = (sessClean && sessClean.floater) || [];
      html += '<div class="clm-floor-section">';
      html += '<h4>Floater</h4>';
      html += '<div class="clm-area">';
      html += '<div class="cle-family-chips">';
      floaterFamilies.forEach(function (f) {
        var aId = findAssignmentId(viewSess, 'floater', 'Floater', f);
        html += '<span class="cle-chip">' + escapeAttr(cleaningDisplayName(f)) + '<button class="cle-chip-x" data-assign-id="' + aId + '">&times;</button></span>';
      });
      html += '</div>';
      html += '<div class="cle-add-row">';
      html += '<input class="cle-input cle-add-input" placeholder="Add Volunteer" list="cle-families-datalist" autocomplete="off" data-area-id="' + floaterArea.id + '" data-session="' + viewSess + '">';
      html += '<button class="cle-btn cle-btn-add" data-area-id="' + floaterArea.id + '" data-session="' + viewSess + '">Add</button>';
      html += '</div>';
      html += '</div>';
      html += '</div>';
    }

    // Copy session
    html += '<div class="cle-copy-row">';
    html += '<span>Copy from:</span>';
    html += '<select class="cle-input" id="clmCopyFrom">';
    for (var cs = 1; cs <= 5; cs++) {
      if (cs !== viewSess) html += '<option value="' + cs + '">Session ' + cs + '</option>';
    }
    html += '</select>';
    html += '<button class="cle-btn cle-btn-save" id="clmCopyBtn">Copy to Session ' + viewSess + '</button>';
    html += '</div>';

    // Footer with liaison name (read-only, matches supply closet pattern)
    html += '<div class="sc-footer" style="margin-top:1rem;">';
    html += '<span></span>';
    if (CLEANING_CREW.liaison) {
      html += '<span class="sc-coord">Cleaning Crew Liaison: <strong>' + escapeAttr(CLEANING_CREW.liaison) + '</strong></span>';
    }
    html += '</div>';

    html += '</div>';

    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';

    // Wire close
    personDetailCard.querySelector('.detail-close').onclick = function () { personDetail.style.display = 'none'; };
    personDetail.onclick = function (e) { if (e.target === personDetail) personDetail.style.display = 'none'; };

    // Wire session buttons
    personDetailCard.querySelectorAll('.cle-sess-btn').forEach(function (btn) {
      btn.onclick = function () {
        cleaningModalSession = parseInt(this.getAttribute('data-sess'), 10);
        renderCleaningModal();
      };
    });



    // Wire remove assignment. If the chip being removed was rendered from
    // sheet data (no DB id yet), first migrate the whole session into the DB
    // so that every existing chip becomes a real, deletable row — then delete
    // the one the user clicked.
    personDetailCard.querySelectorAll('.cle-chip-x').forEach(function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var rawId = btn.getAttribute('data-assign-id');
        var familyName = btn.parentElement ? btn.parentElement.firstChild.textContent : '';
        var needsSeed = !rawId || rawId === 'null';

        var promise = needsSeed
          ? ensureSessionSeeded(cleaningModalSession).then(function () {
              // After seeding, look up the DB id for the chip the user clicked.
              var floorKey = findFloorForFamilyChip(btn);
              var areaName = findAreaForFamilyChip(btn, floorKey);
              var newId = findAssignmentId(cleaningModalSession, floorKey, areaName, familyName);
              return newId ? cleaningApiCall('DELETE', 'action=assignment&id=' + newId) : null;
            })
          : cleaningApiCall('DELETE', 'action=assignment&id=' + rawId);

        promise.then(function () {
          loadCleaningData();
          setTimeout(renderCleaningModal, 300);
        }).catch(function (err) { alert('Error removing: ' + (err && err.message || err)); });
      };
    });

    // Wire add assignment. Same seeding rule: if this session has sheet-
    // derived chips but no DB rows, migrate them all to the DB before
    // inserting the new name, so the UI doesn't lose the existing chips when
    // applyCleaningData() overwrites CLEANING_CREW.sessions[s] from the DB.
    personDetailCard.querySelectorAll('.cle-btn-add').forEach(function (btn) {
      btn.onclick = function () {
        var input = btn.parentElement.querySelector('.cle-add-input');
        var name = input.value.trim();
        if (!name) return;
        var session = parseInt(btn.getAttribute('data-session'), 10);
        var areaId = parseInt(btn.getAttribute('data-area-id'), 10);
        btn.disabled = true;
        var originalText = btn.textContent;
        btn.textContent = 'Saving\u2026';

        ensureSessionSeeded(session)
          .then(function () {
            return cleaningApiCall('POST', 'action=assignment', {
              session_number: session,
              cleaning_area_id: areaId,
              family_name: name
            });
          })
          .then(function (r) {
            if (r && r.error) { alert(r.error); btn.disabled = false; btn.textContent = originalText; return; }
            loadCleaningData();
            setTimeout(renderCleaningModal, 300);
          })
          .catch(function (err) {
            alert('Error saving: ' + (err && err.message || err));
            btn.disabled = false;
            btn.textContent = originalText;
          });
      };
    });

    // Wire task editor toggles
    personDetailCard.querySelectorAll('.cle-tasks-toggle').forEach(function (btn) {
      btn.onclick = function () {
        var areaId = btn.getAttribute('data-area-id');
        var editor = document.getElementById('clmTasksEditor-' + areaId);
        if (!editor) return;
        if (editor.style.display !== 'none') { editor.style.display = 'none'; return; }
        var floorKey = btn.getAttribute('data-floor');
        var areaName = btn.getAttribute('data-area');
        var tasks = findAreaTasks(floorKey, areaName);
        var h = '<div class="cle-task-list">';
        tasks.forEach(function (t, i) {
          h += '<div class="cle-task-row"><textarea class="cle-task-input" data-idx="' + i + '">' + t.replace(/</g, '&lt;') + '</textarea>';
          h += '<button class="cle-chip-x cle-task-del" data-idx="' + i + '">&times;</button></div>';
        });
        h += '</div>';
        h += '<div class="cle-task-actions">';
        h += '<button class="cle-btn" id="clmAddTask-' + areaId + '">+ Add Task</button>';
        h += '<button class="cle-btn cle-btn-save" id="clmSaveTasks-' + areaId + '">Save Tasks</button>';
        h += '</div>';
        editor.innerHTML = h;
        editor.style.display = 'block';

        document.getElementById('clmAddTask-' + areaId).onclick = function () {
          var list = editor.querySelector('.cle-task-list');
          var row = document.createElement('div');
          row.className = 'cle-task-row';
          row.innerHTML = '<textarea class="cle-task-input"></textarea><button class="cle-chip-x cle-task-del">&times;</button>';
          list.appendChild(row);
          row.querySelector('.cle-task-del').onclick = function () { row.remove(); };
        };
        editor.querySelectorAll('.cle-task-del').forEach(function (db) { db.onclick = function () { db.parentElement.remove(); }; });
        document.getElementById('clmSaveTasks-' + areaId).onclick = function () {
          var newTasks = [];
          editor.querySelectorAll('.cle-task-input').forEach(function (inp) { var v = inp.value.trim(); if (v) newTasks.push(v); });
          cleaningApiCall('PATCH', 'action=area&id=' + areaId, { tasks: newTasks }).then(function () {
            for (var i = 0; i < cleaningDB.areas.length; i++) {
              if (cleaningDB.areas[i].id === parseInt(areaId, 10)) { cleaningDB.areas[i].tasks = newTasks; break; }
            }
            renderCleaningModal();
          });
        };
      };
    });

    // Wire copy session
    var copyBtn = document.getElementById('clmCopyBtn');
    if (copyBtn) {
      copyBtn.onclick = function () {
        var fromSess = parseInt(document.getElementById('clmCopyFrom').value, 10);
        var toSess = cleaningModalSession;
        var fromAssignments = cleaningDB.assignments.filter(function (a) { return a.session_number === fromSess; });
        if (fromAssignments.length === 0) { alert('No assignments in session ' + fromSess); return; }
        if (!confirm('Copy ' + fromAssignments.length + ' assignments from session ' + fromSess + ' to session ' + toSess + '?')) return;
        Promise.all(fromAssignments.map(function (a) {
          return cleaningApiCall('POST', 'action=assignment', { session_number: toSess, cleaning_area_id: a.cleaning_area_id, family_name: a.family_name });
        })).then(function () { loadCleaningData(); setTimeout(renderCleaningModal, 300); });
      };
    }
  }

  function renderVolunteersTab() {
    var container = document.getElementById('volunteersTabContent');
    if (!container) return;
    var myNames = getMyNames();

    var html = '<h3>Volunteer Committees &mdash; 2025\u20132026</h3>';
    html += '<div class="portal-volunteer-grid">';

    VOLUNTEER_COMMITTEES.forEach(function (committee) {
      var isMyCommittee = false;
      if (committee.chair && myNames.fullNames.some(function (fn) { return fn.toLowerCase() === (committee.chair.person || '').trim().toLowerCase(); })) isMyCommittee = true;
      committee.roles.forEach(function (r) { if (r.person && myNames.fullNames.some(function (fn) { return fn.toLowerCase() === r.person.trim().toLowerCase(); })) isMyCommittee = true; });
      html += '<div class="portal-role-card' + (isMyCommittee ? ' coord-my-card' : '') + '">';
      html += '<h4>' + committee.name + '</h4>';
      if (committee.chair) {
        var chairRoleKey = getRoleKeyForDuty(committee.chair.title);
        var chairTitle = committee.chair.title;
        if (chairRoleKey && getRoleByKey(chairRoleKey)) {
          chairTitle = '<a class="rd-role-link" data-role-key="' + chairRoleKey + '" href="#" onclick="return false;">' + committee.chair.title + '</a>';
        }
        html += '<div class="committee-chair"><strong>' + chairTitle + ':</strong> ' + highlightIfMe(committee.chair.person, myNames) + '</div>';
      }
      html += '<ul>';
      committee.roles.forEach(function (r) {
        var personText = r.person ? highlightIfMe(r.person, myNames) : '<em>Open</em>';
        var roleKey = getRoleKeyForDuty(r.title);
        var roleTitle = r.title;
        if (roleKey && getRoleByKey(roleKey)) {
          roleTitle = '<a class="rd-role-link" data-role-key="' + roleKey + '" href="#" onclick="return false;">' + r.title + '</a>';
        }
        html += '<li><strong>' + roleTitle + ':</strong> ' + personText + '</li>';
      });
      html += '</ul></div>';
    });
    html += '</div>';

    container.innerHTML = html;
    // Wire role description links
    container.querySelectorAll('.rd-role-link').forEach(function (link) {
      link.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        showRoleDescriptionModal(this.getAttribute('data-role-key'), false);
      };
    });
  }

  function renderEventsTab() {
    var container = document.getElementById('eventsTabContent');
    if (!container) return;
    var myNames = getMyNames();

    // Match by first name since event coordinator field is first-name only
    function isMyEvent(name) {
      if (!name || !myNames.fullNames.length) return false;
      var nl = name.trim().toLowerCase();
      return myNames.fullNames.some(function (fn) {
        return fn.toLowerCase() === nl || fn.split(' ')[0].toLowerCase() === nl;
      });
    }

    var html = '<h3>Special Events &mdash; 2025\u20132026</h3>';
    html += '<div class="events-grid">';

    SPECIAL_EVENTS.forEach(function (ev) {
      var statusClass = ev.status === 'Complete' ? 'status-done' : ev.status === 'Needs Volunteers' ? 'status-open' : 'status-upcoming';
      var coordText = ev.coordinator || '<em class="event-open-slot">Needs volunteer</em>';
      var filled = ev.planningSupport.filter(function (s) { return s !== ''; }).length;

      var isMyCard = isMyEvent(ev.coordinator) || ev.planningSupport.some(function (p) { return isMyEvent(p); });

      html += '<div class="event-card' + (isMyCard ? ' coord-my-card' : '') + '">';
      html += '<div class="event-card-header">';
      html += '<div>';
      html += '<strong class="event-card-name">' + ev.name + '</strong>';
      html += '<div class="event-card-date">' + ev.date + '</div>';
      html += '</div>';
      html += '<span class="status-badge ' + statusClass + '">' + ev.status + '</span>';
      html += '</div>';

      // Coordinator
      html += '<div class="event-roles">';
      html += '<div class="event-role' + (isMyEvent(ev.coordinator) ? ' coord-my-row' : '') + '">';
      html += '<span class="event-role-label">Coordinator</span>';
      html += '<span class="event-role-person">' + (isMyEvent(ev.coordinator) ? '<span class="coord-highlight">' + coordText + '</span>' : coordText) + '</span>';
      html += '</div>';

      // Planning support slots
      ev.planningSupport.forEach(function (person, idx) {
        var isMe = isMyEvent(person);
        html += '<div class="event-role' + (isMe ? ' coord-my-row' : '') + '">';
        html += '<span class="event-role-label">Support ' + (idx + 1) + '</span>';
        if (person) {
          html += '<span class="event-role-person">' + (isMe ? '<span class="coord-highlight">' + person + '</span>' : person) + '</span>';
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

  // ──────────────────────────────────────────────
  // 7c. My Workspace tab — role-aware, per-member customisable
  // ──────────────────────────────────────────────
  //
  // Model: each member sees a stack of "widget" cards based on the roles
  // they hold. A registry maps widget-type → render() + role gate. Defaults
  // per role live in WORKSPACE_DEFAULTS. A per-user prefs blob in
  // localStorage lets the member hide widgets and maintain a personal
  // "My Links" list. When we migrate to DB-backed prefs (see MEMORY.md
  // rw-billing-integration / sheets-inventory timelines), swap the
  // getWorkspacePrefs/saveWorkspacePrefs helpers without touching widgets.

  var WORKSPACE_PREFS_KEY_PREFIX = 'rw_workspace_prefs_';

  // Fixed link set used by the admin-consoles widget.
  // Kept inline in v1; move to DB when the volunteer-sheet migration lands.
  var WORKSPACE_ADMIN_CONSOLES = [
    { title: 'Google Admin', url: 'https://admin.google.com/', icon: '\u2699' },
    { title: 'Vercel', url: 'https://vercel.com/dashboard', icon: '\u25B2' },
    { title: 'GitHub', url: 'https://github.com/communications-arch/roots-and-wings', icon: '\uD83D\uDC19' },
    { title: 'Neon Postgres', url: 'https://console.neon.tech/', icon: '\uD83D\uDDC4' },
    { title: 'Resend (email)', url: 'https://resend.com/emails', icon: '\u2709' },
    { title: 'GoDaddy', url: 'https://sso.godaddy.com/', icon: '\uD83C\uDF10' }
  ];

  function getWorkspacePrefs() {
    var email = getActiveEmail() || 'anonymous';
    try {
      var raw = localStorage.getItem(WORKSPACE_PREFS_KEY_PREFIX + email);
      if (!raw) return { hidden: [], myLinks: [] };
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return { hidden: [], myLinks: [] };
      if (!Array.isArray(parsed.hidden)) parsed.hidden = [];
      if (!Array.isArray(parsed.myLinks)) parsed.myLinks = [];
      return parsed;
    } catch (e) {
      return { hidden: [], myLinks: [] };
    }
  }
  function saveWorkspacePrefs(prefs) {
    var email = getActiveEmail() || 'anonymous';
    try { localStorage.setItem(WORKSPACE_PREFS_KEY_PREFIX + email, JSON.stringify(prefs)); }
    catch (e) { console.error('workspace prefs save failed:', e); }
  }

  // Canonicalise abbreviated volunteer-committee titles to the full form used
  // by role_descriptions / DUTY_TO_ROLE_KEY. Matches the scoped BOARD_TITLE_MAP
  // inside applySheetsData and the server-side TITLE_NORMALIZATIONS in
  // api/_permissions.js — keep all three in sync.
  var WORKSPACE_TITLE_NORMALIZATIONS = {
    'membership dir.': 'Membership Director',
    'sustaining dir.': 'Sustaining Director',
    'communications dir.': 'Communications Director',
    'vice-president': 'Vice President',
    'vice president': 'Vice President'
  };
  function normalizeWorkspaceTitle(title) {
    if (!title) return title;
    var key = String(title).trim().toLowerCase();
    return WORKSPACE_TITLE_NORMALIZATIONS[key] || title;
  }

  // Determine the Workspace roles for the currently-viewed user. Respects
  // View As impersonation via getActiveEmail(). Sources:
  //   1. Family's boardRole (assigned in applySheetsData from chair rows)
  //   2. Non-board volunteer-committee roles matched by parent name
  //   3. Super-user shortcut: communications@ always gets Comms Director
  function getWorkspaceRoles() {
    var active = getActiveEmail();
    if (!active) return [];
    var lower = active.toLowerCase();
    var out = [];
    function addRole(title) {
      var norm = normalizeWorkspaceTitle(title);
      if (norm && out.indexOf(norm) === -1) out.push(norm);
    }

    // Find the family for this email, matching either the personal inbox
    // (fam.email) or a board role inbox (fam.boardEmail, e.g., communications@).
    var fam = null;
    for (var i = 0; i < FAMILIES.length; i++) {
      var f = FAMILIES[i];
      var personalMatch = f.email && f.email.toLowerCase() === lower;
      var boardMatch = f.boardEmail && f.boardEmail.toLowerCase() === lower;
      if (personalMatch || boardMatch) { fam = f; break; }
    }

    if (fam && fam.boardRole) addRole(fam.boardRole);

    // Super-user shortcut, regardless of family match
    if (lower === 'communications@rootsandwingsindy.com') addRole('Communications Director');

    if (fam) {
      var parentNames = (fam.parents || '').split(/\s*&\s*/).map(function (first) {
        return (first.trim() + ' ' + fam.name).trim();
      });
      function wsMatch(a, b) {
        if (!a || !b) return false;
        return a.trim().toLowerCase() === b.trim().toLowerCase();
      }
      (VOLUNTEER_COMMITTEES || []).forEach(function (c) {
        if (c.chair && c.chair.person && parentNames.some(function (n) { return wsMatch(c.chair.person, n); })) {
          addRole(c.chair.title);
        }
        (c.roles || []).forEach(function (r) {
          if (r.person && parentNames.some(function (n) { return wsMatch(r.person, n); })) {
            addRole(r.title);
          }
        });
      });
    }
    return out;
  }

  // Widget registry. Each widget: { title, roleGate: null | [titles...], render(prefs, roles) }
  // Role gate null = universal. A widget is shown if roleGate is null OR any of
  // the user's roles is in roleGate.
  var WORKSPACE_WIDGETS = {
    'resources': {
      title: 'Resources',
      roleGate: null,
      render: function () {
        var h = '<p class="ws-body-hint">Handbooks, forms, and co-op references.</p>';
        h += '<ul class="ws-link-list">';
        h += '<li><a href="https://drive.google.com/file/d/1okPkRloZtr4D3_lsavayx-TKZn2fuzHp/view?usp=drive_link" target="_blank" rel="noopener"><span class="ws-link-icon">\uD83D\uDCD6</span>Member Handbook</a></li>';
        h += '<li><button type="button" class="ws-link-btn" data-resource-action="waiver"><span class="ws-link-icon">\u270D</span>Member Agreement &amp; Waivers</button></li>';
        h += '<li><a href="https://docs.google.com/document/d/1y3Ru6dCnKnfejb2kwHmNh42jUI8D6Q4D4f_APSGnpz0/edit?usp=drive_link" target="_blank" rel="noopener"><span class="ws-link-icon">\uD83D\uDCAC</span>Google Chat Guide</a></li>';
        h += '<li><a href="https://docs.google.com/forms/d/e/1FAIpQLSc85NIjyGcESji-RD73yGQB6BHko34lVMzhxvyE1sYBb620kA/viewform" target="_blank" rel="noopener"><span class="ws-link-icon">\uD83D\uDCB5</span>Reimbursement Form</a></li>';
        h += '<li><button type="button" class="ws-link-btn" data-resource-action="curriculum"><span class="ws-link-icon">\uD83D\uDCDA</span>Curriculum Library</button></li>';
        h += '<li><button type="button" class="ws-link-btn" data-resource-action="class-ideas"><span class="ws-link-icon">\uD83D\uDCA1</span>Class Ideas</button></li>';
        h += '<li><button type="button" class="ws-link-btn" data-resource-action="supply-closet"><span class="ws-link-icon">\uD83D\uDCE6</span>Supply Closet Inventory</button></li>';
        h += '</ul>';
        return h;
      }
    },
    'my-links': {
      title: 'My Links',
      roleGate: null,
      render: function (prefs) {
        var h = '<p class="ws-body-hint">Your own collection — Pinterest boards, docs, anything.</p>';
        h += '<ul class="ws-link-list" id="ws-mylinks-list">';
        if (prefs.myLinks.length === 0) {
          h += '<li class="ws-empty">No links yet. Add your first below.</li>';
        } else {
          prefs.myLinks.forEach(function (l, idx) {
            h += '<li><a href="' + l.url + '" target="_blank" rel="noopener"><span class="ws-link-icon">\uD83D\uDD17</span>' + l.title + '</a>';
            h += ' <button class="sc-btn sc-btn-del ws-mylink-del" data-idx="' + idx + '" aria-label="Remove">\u00d7</button></li>';
          });
        }
        h += '</ul>';
        h += '<div class="ws-mylink-form">';
        h += '<input type="text" id="ws-mylink-title" placeholder="Label" maxlength="80" />';
        h += '<input type="url" id="ws-mylink-url" placeholder="https://..." maxlength="400" />';
        h += '<button class="btn btn-primary btn-sm" id="ws-mylink-add">Add</button>';
        h += '</div>';
        return h;
      }
    },
    'ways-to-help': {
      title: 'Ways to Help',
      roleGate: null,
      render: function () {
        var h = '';

        // ── Your year so far (personal participation panel) ────────────
        // Backed by the same data as the greeting's plant badge
        // (_participationMine). If it hasn't loaded yet we show a
        // placeholder; loadParticipationBadge() re-renders the workspace
        // tab once the fetch completes.
        var member = _participationMine && _participationMine.member;
        if (member) {
          var tier = deriveParticipationTier(member);
          var tierHeadline = {
            sprout:  'Every contribution matters — here’s how to jump in.',
            sapling: 'You’re well on your way this year.',
            tree:    'You’re a cornerstone of our co-op this year. Thank you!'
          }[tier] || '';
          var expected = Number(member.expectedPoints) || 0;
          var total = Number(member.weightedTotal) || 0;
          var pct = expected > 0 ? Math.min(100, Math.round((total / expected) * 100)) : 100;
          h += '<div class="ws-part-panel ws-part-panel-' + tier + '">';
          h += '<div class="ws-part-panel-head">';
          h += '<span class="ws-part-panel-icon" aria-hidden="true">' + (PLANT_SVGS[tier] || '') + '</span>';
          h += '<div class="ws-part-panel-headings">';
          h += '<h5>Your year so far</h5>';
          h += '<p>' + escapeHtml(tierHeadline) + '</p>';
          h += '</div>';
          h += '</div>';

          // Progress meter. For exempt members expected is ~0; we
          // render a full bar and a "thanks for what you’ve given"
          // line instead of the usual points readout.
          if (expected < 0.5 && member.exemption) {
            h += '<p class="ws-part-exempt-note">Thanks for what you’ve given this year — your plan is marked as a break for now.</p>';
          } else {
            h += '<div class="ws-part-meter" role="img" aria-label="' + total.toFixed(1) + ' of ' + expected.toFixed(1) + ' participation points">';
            h += '<div class="ws-part-meter-fill" style="width:' + pct + '%;"></div>';
            h += '</div>';
            h += '<p class="ws-part-meter-caption"><strong>' + total.toFixed(1) + '</strong> of <strong>' + expected.toFixed(1) + '</strong> participation points';
            if (member.isNewMember) h += ' <span class="ws-part-new-pill">New this year</span>';
            h += '</p>';
          }

          // Recap: translate counts into sentences.
          var recap = [];
          var c = member.counts || {};
          function pluralize(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
          if (c.am_lead)          recap.push('Taught ' + pluralize(c.am_lead, 'AM session', 'AM sessions'));
          if (c.am_assist)        recap.push('Assisted ' + pluralize(c.am_assist, 'AM session', 'AM sessions'));
          if (c.pm_lead)          recap.push('Led ' + pluralize(c.pm_lead, 'PM elective', 'PM electives'));
          if (c.pm_assist)        recap.push('Assisted ' + pluralize(c.pm_assist, 'PM elective', 'PM electives'));
          if (c.cleaning_session) recap.push('Cleaned ' + pluralize(c.cleaning_session, 'session', 'sessions'));
          if (c.event_lead)       recap.push('Coordinated ' + pluralize(c.event_lead, 'special event', 'special events'));
          if (c.event_assist)     recap.push('Supported ' + pluralize(c.event_assist, 'event', 'events'));
          if (member.coverageGiven) recap.push('Covered ' + pluralize(member.coverageGiven, 'slot', 'slots') + ' for others');
          if (recap.length) {
            h += '<ul class="ws-part-recap">';
            recap.forEach(function (line) { h += '<li>' + escapeHtml(line) + '</li>'; });
            h += '</ul>';
          }
          if (member.roles && member.roles.length) {
            h += '<p class="ws-part-roles-line"><strong>Roles:</strong> ' + member.roles.map(escapeHtml).join(' · ') + '</p>';
          }

          h += '</div>'; // /.ws-part-panel
        } else if (_participationMineEmail && localStorage.getItem('rw_google_credential')) {
          // Fetch is in flight (or errored silently). Show a gentle
          // placeholder so the card isn't empty on first paint.
          h += '<div class="ws-part-panel ws-part-panel-loading">';
          h += '<p class="ws-part-meter-caption">Loading your year so far…</p>';
          h += '</div>';
        }

        // ── Ways to get more involved (open seats) ─────────────────────
        var open = [];
        (VOLUNTEER_COMMITTEES || []).forEach(function (c) {
          if (c.chair && !c.chair.person) open.push({ committee: c.name, title: c.chair.title });
          (c.roles || []).forEach(function (r) { if (!r.person) open.push({ committee: c.name, title: r.title }); });
        });
        h += '<h5 class="ws-part-subhead">Ways to get more involved</h5>';
        // A PM class proposal is always a welcome way to contribute, whether
        // or not committee seats are open. Button opens the same submission
        // modal that the My Family "+ Submit a PM Class" card uses.
        h += '<p class="ws-part-submit-line"><button type="button" class="ws-part-submit-link" data-resource-action="submit-pm-class">✨ Submit a PM Class</button><span class="ws-part-submit-hint">Teach an elective you love — propose an idea for an upcoming session.</span></p>';
        if (open.length === 0) {
          h += '<p class="ws-empty">Every volunteer seat is filled right now. If you want to start something new, pitch it in <a href="https://chat.google.com/" target="_blank" rel="noopener">Google Chat</a>.</p>';
        } else {
          h += '<p class="ws-body-hint">Open committee seats — email <a href="mailto:membership@rootsandwingsindy.com">membership@rootsandwingsindy.com</a> to claim one.</p>';
          h += '<ul class="ws-opportunities">';
          open.forEach(function (o) {
            h += '<li><strong>' + escapeHtml(o.title) + '</strong> <span class="ws-opp-committee">' + escapeHtml(o.committee) + '</span></li>';
          });
          h += '</ul>';
        }
        return h;
      }
    },
    'admin-consoles': {
      title: 'Admin Consoles',
      roleGate: ['Communications Director'],
      render: function () {
        var h = '<p class="ws-body-hint">External dashboards for the tools powering the site.</p>';
        h += '<ul class="ws-link-list">';
        WORKSPACE_ADMIN_CONSOLES.forEach(function (l) {
          h += '<li><a href="' + l.url + '" target="_blank" rel="noopener"><span class="ws-link-icon">' + l.icon + '</span>' + l.title + '</a></li>';
        });
        h += '</ul>';
        return h;
      }
    },
    'roles': {
      // President-only roles manager. Communications sees it while
      // View-As'ing the President because getWorkspaceRoles resolves
      // against the active (view-as) email. roleGate is set so it only
      // appears for the President — the server enforces meta-edits too.
      title: 'Roles & Committees',
      roleGate: ['President'],
      render: function () {
        var h = '<p class="ws-body-hint">Manage every role’s job description, term, and hierarchy across the co-op.</p>';
        h += '<ul class="ws-link-list">';
        h += '<li><button type="button" class="ws-link-btn" data-resource-action="roles-manager"><span class="ws-link-icon">🧭</span>Open Roles Manager<span class="ws-link-count" id="rolesmgr-count" hidden></span></button></li>';
        h += '</ul>';
        return h;
      },
      afterRender: function () {
        if (typeof loadRolesManagerCount === 'function') loadRolesManagerCount();
      }
    },
    'pm-scheduling': {
      // Visible only to the roles that actually run PM scheduling: VP
      // and the Afternoon Class Liaison (the PM scheduler).
      // communications@ is a super user server-side but we hide the
      // widget from her own profile so it surfaces only when she
      // View-As's into a VP / PM-scheduler row.
      title: 'PM Class Scheduling',
      roleGate: ['Vice President', 'Afternoon Class Liaison'],
      render: function () {
        var h = '<p class="ws-body-hint">Review inbound PM class submissions and draft the upcoming session.</p>';
        h += '<ul class="ws-link-list">';
        h += '<li><button type="button" class="ws-link-btn" data-resource-action="schedule-builder"><span class="ws-link-icon">📋</span>Open Schedule Builder</button></li>';
        // The submissions report opens in a modal so the workspace card
        // stays scannable. Count of pending-submitted is fetched in
        // afterRender and painted into the ws-link-count pill so the
        // reviewer sees activity at a glance without opening it.
        h += '<li><button type="button" class="ws-link-btn" data-resource-action="pm-submissions-report"><span class="ws-link-icon">📝</span>Submissions Report<span class="ws-link-count" id="pmrep-pending-count" hidden></span></button></li>';
        h += '</ul>';
        return h;
      },
      afterRender: function () {
        if (typeof loadPmSubmissionsPendingCount === 'function') loadPmSubmissionsPendingCount();
      }
    },
    'todos': {
      // Per-role action queue. Items show only when the active role has
      // something waiting (e.g. Treasurer sees pending cash/check
      // payments; Comms sees new families to onboard). When every item
      // is hidden the card collapses to an "all caught up" empty state.
      // Server-side data fetches stay role-scoped via the /api/tour?
      // list=registrations endpoint each loader hits.
      title: 'To Do',
      roleGate: ['Treasurer', 'Communications Director'],
      render: function (prefs, roles, role) {
        var h = '<p class="ws-body-hint">Quick links to anything waiting on you.</p>';
        h += '<ul class="ws-link-list" id="ws-todo-list">';
        if (role === 'Treasurer') {
          h += '<li id="ws-todo-pending-item" hidden><button type="button" class="ws-link-btn" data-resource-action="treasurer-pending-payments"><span class="ws-link-pre-count" id="ws-todo-pending-count">0</span><span class="ws-link-icon">💰</span><span id="ws-todo-pending-label">Pending Payment Registrations</span></button></li>';
        }
        if (role === 'Communications Director') {
          h += '<li id="ws-todo-onboard-item" hidden><button type="button" class="ws-link-btn" data-resource-action="member-onboarding"><span class="ws-link-pre-count" id="ws-onboard-count">0</span><span class="ws-link-icon">🌱</span><span id="ws-onboard-label">Member Onboarding</span></button></li>';
          h += '<li id="ws-todo-waivers-item" hidden><button type="button" class="ws-link-btn" data-resource-action="waivers-pending"><span class="ws-link-pre-count" id="ws-waivers-count">0</span><span class="ws-link-icon">📝</span><span id="ws-waivers-label">Pending Waivers</span></button></li>';
        }
        h += '<li id="ws-todo-empty" class="ws-empty">All caught up — nothing pending.</li>';
        h += '</ul>';
        return h;
      },
      afterRender: function () {
        // afterRender gets no role context (renderSection calls it once
        // per type, not per role-section). Each loader self-gates by
        // checking for its own DOM element and no-ops if missing — so
        // we can safely fire all three. Whichever role's tab is on the
        // page picks up its own item.
        if (typeof loadTreasurerPendingCount === 'function') loadTreasurerPendingCount();
        if (typeof loadMemberOnboardingCount === 'function') loadMemberOnboardingCount();
        if (typeof loadPendingWaiversCount === 'function') loadPendingWaiversCount();
      }
    },
    'reports': {
      title: 'Reports',
      roleGate: ['Communications Director', 'Membership Director', 'Vice President', 'Afternoon Class Liaison', 'Treasurer'],
      render: function (prefs, roles, role) {
        var items = (ROLE_REPORTS[role] || []).slice();
        // Member Participation belongs to the VP + Afternoon Class Liaison
        // (PM coordinator). Super users see it only when they View-As into
        // one of those roles — handled implicitly because `role` resolves
        // from the active (impersonated) email.
        var sharedParticipation = { key: 'participation', title: 'Member Participation' };
        if (role === 'Vice President' || role === 'Afternoon Class Liaison') {
          if (!items.some(function (r) { return r.key === 'participation'; })) {
            items.unshift(sharedParticipation);
          }
        }
        var h = '<p class="ws-body-hint">Live reports scoped to your role.</p>';
        h += '<ul class="ws-link-list">';
        if (items.length === 0) {
          h += '<li class="ws-empty">No reports configured for this role yet.</li>';
        } else {
          items.forEach(function (r) {
            if (r.url) {
              h += '<li><a class="ws-link-btn" href="' + r.url + '" target="_blank" rel="noopener"><span class="ws-link-icon">\uD83D\uDCCA</span>' + escapeHtml(r.title) + '</a></li>';
            } else {
              h += '<li><button type="button" class="ws-link-btn" data-report-key="' + r.key + '"><span class="ws-link-icon">\uD83D\uDCCA</span>' + escapeHtml(r.title) + '</button></li>';
            }
          });
        }
        h += '</ul>';
        h += '<p class="ws-report-request-hint">Need a different report? Email the <a href="mailto:communications@rootsandwingsindy.com">Communications Director</a>.</p>';
        return h;
      }
    },
    'forms': {
      title: 'Forms',
      roleGate: ['Communications Director', 'Membership Director', 'Vice President'],
      render: function (prefs, roles, role) {
        var items = (ROLE_FORMS[role] || []);
        var h = '<p class="ws-body-hint">Send a form or invite to someone outside the co-op.</p>';
        h += '<ul class="ws-link-list">';
        if (items.length === 0) {
          h += '<li class="ws-empty">No forms configured for this role yet.</li>';
        } else {
          items.forEach(function (f) {
            h += '<li><button type="button" class="ws-link-btn" data-form-key="' + f.key + '"><span class="ws-link-icon">\u270D</span>' + escapeHtml(f.title) + '</button></li>';
          });
        }
        h += '</ul>';
        return h;
      }
    }
  };

  // Per-role report and form registries. Each entry opens a modal via the
  // handlers in renderWorkspaceTab. Keep keys lowercase-kebab so they can be
  // safely embedded in data-* attributes.
  var ROLE_REPORTS = {
    'Communications Director': [
      { key: 'waivers', title: 'Waivers Report' },
      { key: 'membership', title: 'Membership Report' }
    ],
    'Membership Director': [
      { key: 'membership', title: 'Membership Report' }
    ],
    'Treasurer': [
      { key: 'membership', title: 'Membership Report' }
    ],
    'Vice President': []
  };
  var ROLE_FORMS = {
    'Communications Director': [
      { key: 'send-waiver', title: 'Send One-Off Waiver' }
    ],
    'Membership Director': [
      { key: 'send-registration', title: 'Send Registration Form' }
    ],
    'Vice President': []
  };

  var WORKSPACE_DEFAULTS = {
    'President': ['roles', 'my-links', 'ways-to-help', 'resources'],
    'Communications Director': ['todos', 'reports', 'forms', 'admin-consoles', 'my-links', 'ways-to-help', 'resources'],
    'Membership Director': ['reports', 'forms', 'my-links', 'ways-to-help', 'resources'],
    'Treasurer': ['todos', 'reports', 'my-links', 'ways-to-help', 'resources'],
    'Vice President': ['reports', 'forms', 'pm-scheduling', 'my-links', 'ways-to-help', 'resources'],
    'Afternoon Class Liaison': ['reports', 'pm-scheduling', 'my-links', 'ways-to-help', 'resources'],
    '*': ['my-links', 'ways-to-help', 'resources']
  };

  // Resolve the ordered widget list for a user: union of defaults for each
  // role they hold, plus the universal '*' defaults, preserving first-seen
  // order and deduplicating.
  function resolveWidgetOrder(roles) {
    var order = [];
    function add(type) { if (WORKSPACE_WIDGETS[type] && order.indexOf(type) === -1) order.push(type); }
    roles.forEach(function (r) {
      var list = WORKSPACE_DEFAULTS[r];
      if (list) list.forEach(add);
    });
    (WORKSPACE_DEFAULTS['*'] || []).forEach(add);
    return order;
  }

  // Notes persistence: one textarea per role, scoped to the viewing email.
  var WORKSPACE_NOTES_KEY_PREFIX = 'rw_workspace_notes_';
  function workspaceNotesKey(roleKey) {
    var email = getActiveEmail() || 'anonymous';
    return WORKSPACE_NOTES_KEY_PREFIX + email + '_' + roleKey;
  }
  function getWorkspaceNotes(roleKey) {
    try { return localStorage.getItem(workspaceNotesKey(roleKey)) || ''; }
    catch (e) { return ''; }
  }
  function saveWorkspaceNotes(roleKey, value) {
    try { localStorage.setItem(workspaceNotesKey(roleKey), value || ''); }
    catch (e) { console.error('workspace notes save failed:', e); }
  }

  function renderWorkspaceTab() {
    var container = document.getElementById('workspaceTabContent');
    if (!container) return;

    var roles = getWorkspaceRoles();
    var prefs = getWorkspacePrefs();

    // Split widgets into role-scoped and universal buckets. Each role section
    // gets its role-gated widgets; universal widgets (roleGate=null) end up in
    // a trailing "Shared" section regardless of role.
    function widgetListFor(role) {
      var list = WORKSPACE_DEFAULTS[role] || [];
      var out = [];
      list.forEach(function (type) {
        var w = WORKSPACE_WIDGETS[type];
        if (!w || !w.roleGate) return; // universal handled separately
        if (w.roleGate.indexOf(role) === -1) return;
        if (out.indexOf(type) === -1) out.push(type);
      });
      return out;
    }
    var universalTypes = [];
    (WORKSPACE_DEFAULTS['*'] || []).forEach(function (type) {
      var w = WORKSPACE_WIDGETS[type];
      if (w && !w.roleGate && universalTypes.indexOf(type) === -1) universalTypes.push(type);
    });

    var html = '<div class="workspace-intro">';
    html += '<h3>My Workspace</h3>';
    if (roles.length === 0) {
      html += '<p>A personalised area for your tools and the ways you contribute. As you pick up roles, more cards will appear here.</p>';
    }
    html += '</div>';

    // Track visible widget types across all sections so afterRender hooks and
    // form wiring can still iterate a flat list.
    var allVisibleTypes = [];
    var allHiddenTypes = [];

    function renderSection(heading, roleKey, widgetTypes, opts) {
      opts = opts || {};
      var visible = [];
      var hidden = [];
      widgetTypes.forEach(function (type) {
        if (prefs.hidden.indexOf(type) !== -1) hidden.push(type);
        else visible.push(type);
      });
      visible.forEach(function (t) { if (allVisibleTypes.indexOf(t) === -1) allVisibleTypes.push(t); });
      hidden.forEach(function (t) { if (allHiddenTypes.indexOf(t) === -1) allHiddenTypes.push(t); });

      // Only skip the whole section if it has no content *and* no notes slot.
      if (visible.length === 0 && hidden.length === 0 && !opts.showNotes) return '';

      var s = '<section class="workspace-role-section">';
      var role = (opts.showNotes && roleKey) ? getRoleByKey(roleKey) : null;
      s += '<header class="ws-role-header"><h4>' + escapeHtml(heading) + '</h4></header>';

      var showHandoff = !!(opts.showNotes && roleKey);

      if (!showHandoff && visible.length === 0) {
        s += '<p class="ws-empty">All cards for this section are hidden. Restore one below.</p>';
      } else {
        s += '<div class="workspace-grid">';

        if (showHandoff) {
          s += '<div class="mf-card workspace-card ws-handoff-card" data-widget-type="handoff">';
          s += '<div class="workspace-card-header"><h4>Role Overview</h4></div>';
          s += '<div class="workspace-card-body">';

          s += '<div class="ws-handoff-links">';

          // Job Description link — shows updated_by/updated_at stamp.
          s += '<button class="ws-handoff-link" data-role-key="' + roleKey + '" data-handoff-action="jobdesc">';
          s += '<span class="ws-handoff-link-icon" aria-hidden="true">';
          s += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>';
          s += '</span>';
          s += '<span class="ws-handoff-link-body"><span class="ws-handoff-link-title">Job Description</span>';
          if (role) {
            var uBy = role.updated_by || '';
            var uOn = formatUpdatedAt(role.updated_at);
            if (uBy || uOn) {
              s += '<span class="ws-handoff-link-meta">Updated';
              if (uOn) s += ' ' + escapeHtml(uOn);
              if (uBy) s += ' by ' + escapeHtml(uBy);
              s += '</span>';
            }
          }
          s += '</span>';
          s += '<span class="ws-handoff-link-chev" aria-hidden="true">›</span>';
          s += '</button>';

          // Playbook & Handoff Notes link
          s += '<button class="ws-handoff-link" data-role-key="' + roleKey + '" data-handoff-action="playbook">';
          s += '<span class="ws-handoff-link-icon" aria-hidden="true">';
          s += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
          s += '</span>';
          s += '<span class="ws-handoff-link-body"><span class="ws-handoff-link-title">Playbook &amp; Handoff Notes</span>';
          s += '<span class="ws-handoff-link-meta">' + (role && role.playbook ? 'View or edit' : 'Add the first notes') + '</span>';
          s += '</span>';
          s += '<span class="ws-handoff-link-chev" aria-hidden="true">›</span>';
          s += '</button>';

          s += '</div>'; // /.ws-handoff-links

          var notesVal = getWorkspaceNotes(roleKey);
          s += '<div class="ws-role-notes">';
          s += '<label class="ws-role-notes-label" for="ws-notes-' + roleKey + '">My private notes <span class="ws-role-notes-scope">(only you)</span></label>';
          s += '<textarea class="ws-role-notes-textarea" id="ws-notes-' + roleKey + '" data-role-key="' + roleKey + '" rows="3" placeholder="Reminders, scratch work, anything just for you. Not visible to the next role holder.">' + escapeHtml(notesVal) + '</textarea>';
          s += '</div>';

          s += '</div>'; // /.workspace-card-body
          s += '</div>'; // /.ws-handoff-card
        }

        if (visible.length === 0 && showHandoff) {
          // Handoff card shown alone — no additional widgets.
        } else {
          visible.forEach(function (type) {
            var w = WORKSPACE_WIDGETS[type];
            s += '<div class="mf-card workspace-card" data-widget-type="' + type + '">';
            s += '<div class="workspace-card-header">';
            s += '<h4>' + w.title + '</h4>';
            s += '<button class="sc-btn ws-hide-btn" data-widget="' + type + '" title="Hide this card">Hide</button>';
            s += '</div>';
            s += '<div class="workspace-card-body">' + w.render(prefs, roles, heading) + '</div>';
            s += '</div>';
          });
        }

        s += '</div>'; // /.workspace-grid
      }
      s += '</section>';
      return s;
    }

    roles.forEach(function (role) {
      var roleKey = getRoleKeyForDuty(role);
      html += renderSection(role, roleKey, widgetListFor(role), { showNotes: !!roleKey });
    });

    // "Shared" bucket for universal widgets. Always render (even if empty)
    // so a brand-new member sees the My Links / Ways to Help baseline.
    html += renderSection('Shared', null, universalTypes, { showNotes: false });

    if (allHiddenTypes.length > 0) {
      html += '<div class="workspace-hidden"><span class="workspace-hidden-label">Hidden:</span> ';
      allHiddenTypes.forEach(function (type) {
        var w = WORKSPACE_WIDGETS[type];
        html += '<button class="sc-btn ws-restore-btn" data-widget="' + type + '">+ ' + w.title + '</button> ';
      });
      html += '</div>';
    }

    container.innerHTML = html;

    // Per-widget post-render hooks (e.g. kick off async data fetches).
    allVisibleTypes.forEach(function (type) {
      var w = WORKSPACE_WIDGETS[type];
      if (typeof w.afterRender === 'function') {
        try { w.afterRender(); } catch (e) { console.error('workspace widget afterRender ' + type + ':', e); }
      }
    });

    // Notes: persist on every input. Blur alone isn't reliable — async
    // re-renders (e.g. participation badge fetch returning while the user
    // is typing) replace innerHTML, which destroys the focused textarea
    // without firing blur, so in-flight edits would be lost.
    container.querySelectorAll('.ws-role-notes-textarea').forEach(function (ta) {
      ta.addEventListener('input', function () {
        saveWorkspaceNotes(this.getAttribute('data-role-key'), this.value);
      });
    });

    // Handoff card links: route to Job Description or Playbook modal.
    // canEdit=true is safe — the section only renders for roles the current
    // viewer actually holds (getWorkspaceRoles put it there).
    container.querySelectorAll('.ws-handoff-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = this.getAttribute('data-role-key');
        var action = this.getAttribute('data-handoff-action');
        if (!key) return;
        if (action === 'playbook' && typeof showRolePlaybookModal === 'function') {
          showRolePlaybookModal(key, true);
        } else if (typeof showRoleDescriptionModal === 'function') {
          showRoleDescriptionModal(key, true);
        }
      });
    });

    // Hide / restore buttons
    container.querySelectorAll('.ws-hide-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var t = this.getAttribute('data-widget');
        var p = getWorkspacePrefs();
        if (p.hidden.indexOf(t) === -1) p.hidden.push(t);
        saveWorkspacePrefs(p);
        renderWorkspaceTab();
      });
    });
    container.querySelectorAll('.ws-restore-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var t = this.getAttribute('data-widget');
        var p = getWorkspacePrefs();
        p.hidden = p.hidden.filter(function (x) { return x !== t; });
        saveWorkspacePrefs(p);
        renderWorkspaceTab();
      });
    });

    // My Links: add + delete
    var addBtn = container.querySelector('#ws-mylink-add');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var titleEl = container.querySelector('#ws-mylink-title');
        var urlEl = container.querySelector('#ws-mylink-url');
        var title = (titleEl.value || '').trim();
        var url = (urlEl.value || '').trim();
        if (!title || !url) { alert('Both a label and a URL are required.'); return; }
        if (!/^https?:\/\//i.test(url)) { alert('URL must start with http:// or https://'); return; }
        var p = getWorkspacePrefs();
        p.myLinks.push({ title: title, url: url });
        saveWorkspacePrefs(p);
        renderWorkspaceTab();
      });
    }
    container.querySelectorAll('.ws-mylink-del').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(this.getAttribute('data-idx'), 10);
        var p = getWorkspacePrefs();
        if (idx >= 0 && idx < p.myLinks.length) { p.myLinks.splice(idx, 1); saveWorkspacePrefs(p); renderWorkspaceTab(); }
      });
    });

    // Reports card: open the appropriate modal.
    container.querySelectorAll('[data-report-key]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = this.getAttribute('data-report-key');
        if (key === 'waivers') showWaiversReportModal();
        else if (key === 'membership') showMembershipReportModal();
        else if (key === 'participation') showParticipationReportModal();
      });
    });

    // Forms card: open the appropriate modal.
    container.querySelectorAll('[data-form-key]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = this.getAttribute('data-form-key');
        if (key === 'send-waiver') showSendWaiverModal();
        else if (key === 'send-registration') showSendRegistrationFormModal();
      });
    });
  }

  // Async loader for the Waivers Report widget body.
  function loadWaiversReport() {
    var body = document.getElementById('ws-waivers-report-body');
    if (!body) return;
    var cred = localStorage.getItem('rw_google_credential');
    fetch('/api/tour?waivers_report=1', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + cred }
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
    .then(function (res) {
      if (!res.ok) {
        var msg = (res.data && res.data.error) || 'error';
        if (res.data && res.data.youAre) {
          msg += ' (logged in as ' + res.data.youAre + ', expected ' + res.data.expected + ')';
        }
        body.innerHTML = '<p class="ws-empty ws-wv-err">Could not load waivers: ' + msg + '</p>';
        return;
      }
      var backup = res.data.backup || [];
      var oneOff = res.data.oneOff || [];
      var registration = res.data.registration || [];
      // Merge \u2014 source label fixed (was incorrectly tagged "Registration"
      // for backup coaches; now correctly "Backup Coach"). Adds a new
      // "Registration" source for Main LC + adult-student signers from
      // the registrations table.
      var merged = [];
      backup.forEach(function (b) {
        merged.push({ source: 'Backup Coach', name: b.name, email: b.email, signed: !!b.signed_at, sent_at: b.sent_at, signed_at: b.signed_at, context: b.sent_by ? 'for ' + b.sent_by : '' });
      });
      oneOff.forEach(function (o) {
        merged.push({ source: 'One-off', name: o.name, email: o.email, signed: !!o.signed_at, sent_at: o.sent_at, signed_at: o.signed_at, context: o.sent_by ? 'by ' + o.sent_by : '' });
      });
      registration.forEach(function (r) {
        merged.push({ source: 'Registration', name: r.name, email: r.email, signed: true, sent_at: r.sent_at, signed_at: r.signed_at, context: r.context || '' });
      });
      // Default sort: pending first, then by sent date desc within each
      // group. The user can re-sort via column headers; this is just the
      // initial view that surfaces action items at the top.
      merged.sort(function (a, b) {
        if (a.signed !== b.signed) return a.signed ? 1 : -1;
        return (b.sent_at || '').localeCompare(a.sent_at || '');
      });

      var total = merged.length;
      var unsigned = merged.filter(function (w) { return !w.signed; }).length;
      var headerHtml = '<p class="ws-body-hint"><strong>' + total + '</strong> total waivers \u00b7 <strong class="' + (unsigned > 0 ? 'ws-wv-pending' : 'ws-wv-ok') + '">' + unsigned + ' pending</strong> \u00b7 pending stay on top</p>';
      if (merged.length === 0) {
        body.innerHTML = headerHtml + '<p class="ws-empty">No waivers sent yet.</p>';
        return;
      }
      body.innerHTML = headerHtml + '<div id="ws-waivers-table-target"></div>';
      var tableTarget = body.querySelector('#ws-waivers-table-target');
      renderSortableTable(tableTarget, [
        { key: 'name', label: 'Name', type: 'string', render: function (w) { return escapeHtmlWs(w.name); } },
        { key: 'email', label: 'Email', type: 'string', render: function (w) { return escapeHtmlWs(w.email); } },
        { key: 'source', label: 'Source', type: 'string',
          render: function (w) {
            var s = escapeHtmlWs(w.source);
            return w.context ? s + '<br><span class="ws-wv-context">' + escapeHtmlWs(w.context) + '</span>' : s;
          }
        },
        { key: 'status', label: 'Status', type: 'string',
          // Pending sorts BEFORE signed by default. Letting the user
          // toggle ascending puts signed first.
          sortValue: function (w) { return w.signed ? 'z' : 'a'; },
          render: function (w) {
            return renderStatusPill(w.signed ? 'signed' : 'pending', w.signed_at);
          }
        },
        { key: 'sent_at', label: 'Sent', type: 'date',
          render: function (w) { return formatReportDate(w.sent_at); }
        }
      ], merged, { initialSort: { key: 'status', dir: 'asc' } });
    }).catch(function (err) {
      body.innerHTML = '<p class="ws-empty ws-wv-err">Network error loading waivers: ' + ((err && err.message) || 'unknown') + '</p>';
    });
  }

  function escapeHtmlWs(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Compact local date: "Apr 27". Used by report tables to keep Status
  // pills tight on the right edge.
  //
  // TZ-aware: date-only strings ("2026-04-27") get parsed as local day,
  // not midnight UTC — otherwise they back-shift one day in any timezone
  // west of UTC (the "signed yesterday" bug Comms saw). Timestamps with
  // a time component go through normal Date parsing and render in the
  // viewer's timezone correctly.
  function formatReportDate(d) {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      var p = d.split('-');
      var local = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
      return local.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    var date = (d instanceof Date) ? d : new Date(d);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // Shared status-pill renderer for the Membership + Waivers reports.
  // Consistent shape: one pill (Paid / Signed / Pending) optionally
  // followed by a date stamp. Centralized so future reports adopt it
  // without re-deriving the format.
  function renderStatusPill(state, dateInput) {
    var stamp = formatReportDate(dateInput);
    if (state === 'paid') return '<span class="ws-wv-ok">Paid</span>' + (stamp ? ' <span class="ws-wv-stamp">' + escapeHtmlWs(stamp) + '</span>' : '');
    if (state === 'signed') return '<span class="ws-wv-ok">Signed</span>' + (stamp ? ' <span class="ws-wv-stamp">' + escapeHtmlWs(stamp) + '</span>' : '');
    return '<span class="ws-wv-pending">Pending</span>';
  }

  // ─── Sortable report-table helper ───
  //
  // Used by the Waivers Report and Membership Report modals. Renders a table
  // whose column headers toggle ascending/descending sort, and optionally
  // expands rows into a detail panel when clicked.
  //
  // columns: [{
  //   key,        // field name on the row (or synthetic — whatever the sortValue fn returns)
  //   label,      // header text
  //   type,       // 'string' | 'date' | 'number' — controls comparator
  //   render,     // (row) => cell HTML
  //   sortValue,  // optional (row) => primitive for comparison; defaults to row[key]
  //   sortable    // default true — set false to disable sorting on this column
  // }]
  // opts: { initialSort: {key, dir}, expandable, renderDetail }
  //    expandable rows get a toggle caret in the first column; clicking any
  //    cell (except the caret's row-dedupe) shows renderDetail(row) in a
  //    full-width row below.
  function renderSortableTable(containerEl, columns, rows, opts) {
    if (!containerEl) return;
    opts = opts || {};
    var state = {
      sortKey: (opts.initialSort && opts.initialSort.key) || columns[0].key,
      sortDir: (opts.initialSort && opts.initialSort.dir) || 'desc',
      expanded: {} // rowIdx -> true
    };

    function cmpType(type, a, b) {
      if (type === 'number') {
        var na = Number(a); var nb = Number(b);
        if (isNaN(na)) na = -Infinity;
        if (isNaN(nb)) nb = -Infinity;
        return na - nb;
      }
      if (type === 'date') {
        var da = a ? new Date(a).getTime() : 0;
        var db = b ? new Date(b).getTime() : 0;
        if (isNaN(da)) da = 0;
        if (isNaN(db)) db = 0;
        return da - db;
      }
      return String(a == null ? '' : a).toLowerCase().localeCompare(String(b == null ? '' : b).toLowerCase());
    }

    function getSortValue(col, row) {
      if (typeof col.sortValue === 'function') return col.sortValue(row);
      return row[col.key];
    }

    function currentColumn() {
      for (var i = 0; i < columns.length; i++) if (columns[i].key === state.sortKey) return columns[i];
      return columns[0];
    }

    function sortedIndexes() {
      var col = currentColumn();
      var type = col.type || 'string';
      var idxs = rows.map(function (_, i) { return i; });
      idxs.sort(function (a, b) {
        var c = cmpType(type, getSortValue(col, rows[a]), getSortValue(col, rows[b]));
        return state.sortDir === 'asc' ? c : -c;
      });
      return idxs;
    }

    function render() {
      var colCount = columns.length + (opts.expandable ? 1 : 0);
      var h = '<div class="ws-waivers-table-wrap"><table class="ws-waivers-table ws-sortable-table"><thead><tr>';
      if (opts.expandable) h += '<th class="ws-sort-caret-col" aria-hidden="true"></th>';
      columns.forEach(function (col) {
        var sortable = col.sortable !== false;
        var isActive = sortable && col.key === state.sortKey;
        var arrow = isActive ? (state.sortDir === 'asc' ? '\u25B2' : '\u25BC') : '';
        if (sortable) {
          h += '<th class="ws-sort" data-sort-key="' + escapeHtmlWs(col.key) + '">'
            + '<span class="ws-sort-label">' + escapeHtmlWs(col.label) + '</span>'
            + '<span class="ws-sort-arrow">' + arrow + '</span></th>';
        } else {
          h += '<th>' + escapeHtmlWs(col.label) + '</th>';
        }
      });
      h += '</tr></thead><tbody>';
      var idxs = sortedIndexes();
      idxs.forEach(function (i) {
        var row = rows[i];
        var expanded = !!state.expanded[i];
        h += '<tr class="ws-srt-row' + (opts.expandable ? ' ws-srt-row-expandable' : '') + '" data-row-idx="' + i + '">';
        if (opts.expandable) {
          h += '<td class="ws-srt-caret">' + (expanded ? '\u25BC' : '\u25B6') + '</td>';
        }
        columns.forEach(function (col) {
          h += '<td>' + (typeof col.render === 'function' ? col.render(row) : escapeHtmlWs(row[col.key])) + '</td>';
        });
        h += '</tr>';
        if (opts.expandable && expanded && typeof opts.renderDetail === 'function') {
          h += '<tr class="ws-srt-detail-row"><td colspan="' + colCount + '"><div class="ws-srt-detail">' + opts.renderDetail(row) + '</div></td></tr>';
        }
      });
      h += '</tbody></table></div>';
      containerEl.innerHTML = h;

      // Header click → sort toggle.
      containerEl.querySelectorAll('.ws-sort').forEach(function (th) {
        th.addEventListener('click', function () {
          var key = this.getAttribute('data-sort-key');
          if (state.sortKey === key) {
            state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
          } else {
            state.sortKey = key;
            state.sortDir = 'asc';
          }
          render();
        });
      });

      // Row click → toggle expansion (expandable mode).
      if (opts.expandable) {
        containerEl.querySelectorAll('.ws-srt-row-expandable').forEach(function (tr) {
          tr.addEventListener('click', function () {
            var idx = this.getAttribute('data-row-idx');
            state.expanded[idx] = !state.expanded[idx];
            render();
          });
        });
      }
    }

    render();
  }

  // ─── Workspace Reports / Forms modals ───
  //
  // The Workspace "Reports" and "Forms" cards are just per-role link lists.
  // Each button opens one of the modals below. Modals reuse the shared
  // personDetail / personDetailCard chrome and .elective-detail shell so the
  // look & feel matches Job Description / Playbook / Waiver modals.

  function showWaiversReportModal() {
    if (!personDetail || !personDetailCard) return;
    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail rd-modal">';
    html += '<h3 class="rd-title">Waivers Report</h3>';
    html += '<p class="rd-subtitle">Everyone who has been sent a waiver — registration backups + one-off sends.</p>';
    html += '<div id="ws-waivers-report-body"><p class="ws-empty">Loading waivers\u2026</p></div>';
    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) { if (e.target === personDetail) closeDetail(); });
    loadWaiversReport();
  }

  function showSendWaiverModal() {
    if (!personDetail || !personDetailCard) return;
    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail rd-modal">';
    html += '<h3 class="rd-title">Send One-Off Waiver</h3>';
    html += '<p class="rd-subtitle">Email a signing link to a last-minute adult. They sign via <code>/waiver.html</code> and it shows up in the Waivers report.</p>';
    html += '<div class="ws-waiver-form">';
    html += '<label>Recipient name<input type="text" id="ws-wv-name" maxlength="200" placeholder="Jane Doe"></label>';
    html += '<label>Recipient email<input type="email" id="ws-wv-email" maxlength="200" placeholder="jane@example.com"></label>';
    html += '<label>Note (optional)<textarea id="ws-wv-note" maxlength="500" rows="2" placeholder="Added context that appears in the email..."></textarea></label>';
    html += '<button class="btn btn-primary btn-sm" id="ws-wv-send">Send Waiver</button>';
    html += '<div class="ws-wv-status" id="ws-wv-status"></div>';
    html += '</div>';
    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) { if (e.target === personDetail) closeDetail(); });

    var sendBtn = personDetailCard.querySelector('#ws-wv-send');
    sendBtn.addEventListener('click', function () {
      var nameEl = personDetailCard.querySelector('#ws-wv-name');
      var emailEl = personDetailCard.querySelector('#ws-wv-email');
      var noteEl = personDetailCard.querySelector('#ws-wv-note');
      var statusEl = personDetailCard.querySelector('#ws-wv-status');
      var name = (nameEl.value || '').trim();
      var emailVal = (emailEl.value || '').trim();
      var note = (noteEl.value || '').trim();
      if (!name || !emailVal) { statusEl.className = 'ws-wv-status ws-wv-err'; statusEl.textContent = 'Name and email are required.'; return; }
      sendBtn.disabled = true; var orig = sendBtn.textContent; sendBtn.textContent = 'Sending\u2026';
      statusEl.className = 'ws-wv-status'; statusEl.textContent = '';
      var cred = localStorage.getItem('rw_google_credential');
      fetch('/api/tour', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'waiver-send', name: name, email: emailVal, note: note })
      }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        sendBtn.disabled = false; sendBtn.textContent = orig;
        if (!res.ok) { statusEl.className = 'ws-wv-status ws-wv-err'; statusEl.textContent = (res.data && res.data.error) || 'Send failed.'; return; }
        statusEl.className = 'ws-wv-status ws-wv-ok';
        statusEl.textContent = res.data.emailed
          ? 'Sent. They\u2019ll get the waiver link by email shortly.'
          : 'Stored. Email delivery hiccupped — copy the link: ' + res.data.link;
        nameEl.value = ''; emailEl.value = ''; noteEl.value = '';
      }).catch(function (err) {
        sendBtn.disabled = false; sendBtn.textContent = orig;
        statusEl.className = 'ws-wv-status ws-wv-err';
        statusEl.textContent = 'Network error: ' + ((err && err.message) || 'unknown');
      });
    });
  }

  // Column spec shared by every render of the Membership Report table —
  // hoisted out of showMembershipReportModal so the filter-change re-render
  // can re-use it without duplicating the schema.
  var MEMBERSHIP_TABLE_COLS = [
    { key: 'main_learning_coach', label: 'Main Learning Coach', type: 'string',
      render: function (r) { return escapeHtmlWs(r.main_learning_coach); }
    },
    { key: 'email', label: 'Email', type: 'string',
      render: function (r) { return escapeHtmlWs(r.email); }
    },
    { key: 'track', label: 'Track', type: 'string',
      sortValue: function (r) { return r.track || ''; },
      render: function (r) {
        var t = r.track || '';
        if (r.track === 'Other' && r.track_other) t = 'Other: ' + r.track_other;
        return escapeHtmlWs(t);
      }
    },
    { key: 'kidsCount', label: 'Kids', type: 'number',
      sortValue: function (r) { return (r.kids || []).length; },
      render: function (r) { return String((r.kids || []).length); }
    },
    { key: 'payment_status', label: 'Paid', type: 'string',
      sortValue: function (r) { return String(r.payment_status || '').toLowerCase() === 'paid' ? 'z' : 'a'; },
      render: function (r) {
        var ok = String(r.payment_status || '').toLowerCase() === 'paid';
        return renderStatusPill(ok ? 'paid' : 'pending', null);
      }
    },
    { key: 'waiverStatus', label: 'Waiver', type: 'string',
      sortValue: function (r) { return (!!r.waiver_member_agreement && !!r.signature_name) ? 'z' : 'a'; },
      render: function (r) {
        var ok = !!r.waiver_member_agreement && !!r.signature_name;
        return renderStatusPill(ok ? 'signed' : 'pending', r.signature_date);
      }
    },
    { key: 'created_at', label: 'Registered', type: 'date',
      render: function (r) { return formatReportDate(r.created_at); }
    }
  ];

  function showMembershipReportModal() {
    if (!personDetail || !personDetailCard) return;
    var sheetUrl = 'https://docs.google.com/spreadsheets/d/1ACLxC6nYfzb2vXbL3JzeaedNlqXzAPL-lEfq6dTIkRg/edit';
    var html = '<div class="detail-actions no-print">';
    html += '<a class="sc-btn" href="' + sheetUrl + '" target="_blank" rel="noopener" aria-label="Open the flat CSV-style Google Sheet of all registrations in a new tab">\uD83D\uDCCA View as Google Sheet</a>';
    html += '</div>';
    html += '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail rd-modal">';
    html += '<h3 class="rd-title">Membership Report</h3>';
    html += '<p class="rd-subtitle">Every registration this season, with payment and waiver status.</p>';
    html += '<div id="ws-membership-report-body"><p class="ws-empty">Loading registrations\u2026</p></div>';
    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) { if (e.target === personDetail) closeDetail(); });

    var body = personDetailCard.querySelector('#ws-membership-report-body');
    var cred = localStorage.getItem('rw_google_credential');
    fetch('/api/tour?list=registrations', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + cred }
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
    .then(function (res) {
      if (!res.ok) {
        var msg = (res.data && res.data.error) || 'error';
        if (res.data && res.data.youAre) msg += ' (logged in as ' + res.data.youAre + ', expected ' + res.data.expected + ')';
        body.innerHTML = '<p class="ws-empty ws-wv-err">Could not load registrations: ' + msg + '</p>';
        return;
      }
      var regs = (res.data.registrations || []).map(function (r) {
        // Normalise kids into a consistent array regardless of whether the
        // column came back as JSON string or native JSON.
        var kids = [];
        try {
          kids = Array.isArray(r.kids) ? r.kids : (typeof r.kids === 'string' ? JSON.parse(r.kids) : []);
        } catch (e) { kids = []; }
        var backups = [];
        try {
          backups = Array.isArray(r.backup_coaches) ? r.backup_coaches : (typeof r.backup_coaches === 'string' ? JSON.parse(r.backup_coaches) : []);
        } catch (e) { backups = []; }
        return Object.assign({}, r, { kids: kids || [], backup_coaches: backups || [] });
      });
      var total = regs.length;
      var paidCount = regs.filter(function (r) { return String(r.payment_status || '').toLowerCase() === 'paid'; }).length;
      var pendingCount = total - paidCount;
      var signed = regs.filter(function (r) { return !!r.waiver_member_agreement && !!r.signature_name; }).length;

      // Filter pill: All / Paid / Pending. Treasurer typically wants
      // "Pending" first (action queue); Membership / Comms typically
      // want "All". Default to All.
      var filterHtml = '<div class="ws-mr-filter-row">';
      filterHtml += '<label class="ws-mr-filter-label">Payment status</label>';
      filterHtml += '<select class="cl-input ws-mr-filter" id="ws-mr-status-filter">';
      filterHtml += '<option value="all" selected>All (' + total + ')</option>';
      filterHtml += '<option value="paid">Paid (' + paidCount + ')</option>';
      filterHtml += '<option value="pending">Pending (' + pendingCount + ')</option>';
      filterHtml += '</select>';
      filterHtml += '</div>';

      var headerHtml = '<p class="ws-body-hint"><strong>' + total + '</strong> registered \u00b7 <strong class="ws-wv-ok">' + paidCount + ' paid</strong> \u00b7 <strong class="ws-wv-pending">' + pendingCount + ' pending</strong> \u00b7 <strong class="ws-wv-ok">' + signed + ' signed</strong> \u00b7 click a row to expand</p>';
      if (regs.length === 0) {
        body.innerHTML = headerHtml + '<p class="ws-empty">No registrations yet for this season.</p>';
        return;
      }
      body.innerHTML = filterHtml + headerHtml + '<div id="ws-membership-table-target"></div>';
      var tableTarget = body.querySelector('#ws-membership-table-target');

      // Filter handler \u2014 re-render the table with the filtered subset.
      var statusFilterEl = body.querySelector('#ws-mr-status-filter');
      function regsForFilter() {
        var v = statusFilterEl ? statusFilterEl.value : 'all';
        if (v === 'paid') return regs.filter(function (r) { return String(r.payment_status || '').toLowerCase() === 'paid'; });
        if (v === 'pending') return regs.filter(function (r) { return String(r.payment_status || '').toLowerCase() !== 'paid'; });
        return regs;
      }
      function renderTable() {
        renderSortableTable(tableTarget, MEMBERSHIP_TABLE_COLS, regsForFilter(), {
          initialSort: { key: 'created_at', dir: 'desc' },
          expandable: true,
          renderDetail: renderMembershipRegDetail
        });
      }
      if (statusFilterEl) {
        statusFilterEl.addEventListener('change', renderTable);
      }

      // Delegated click handler for the Decline flow + Treasurer's Mark
      // Paid flow. Both swap the button for a note textarea + confirm/
      // cancel, post on confirm, reload on success.
      body.addEventListener('click', function (e) {
        var markPaidBtn = e.target.closest('.ws-mark-paid-btn');
        if (markPaidBtn) {
          var mpId = markPaidBtn.getAttribute('data-mark-paid-id');
          var mpName = markPaidBtn.getAttribute('data-mark-paid-name');
          var mpWrap = markPaidBtn.closest('.ws-reg-mark-paid');
          mpWrap.innerHTML =
            '<p class="ws-reg-decline-hint"><strong>Mark ' + escapeHtmlWs(mpName) + ' as Paid?</strong> The family\'s My Family billing card will flip to Paid and a payment-received email goes out.</p>' +
            '<textarea class="rd-textarea ws-mark-paid-note" rows="2" placeholder="Optional note for the email (e.g. check #1234 received)&hellip;"></textarea>' +
            '<div class="rd-btn-row">' +
              '<button type="button" class="sc-btn ws-mark-paid-confirm-btn" data-mark-paid-id="' + escapeHtmlWs(mpId) + '">Confirm — mark Paid</button>' +
              '<button type="button" class="sc-btn ws-mark-paid-cancel-btn">Cancel</button>' +
            '</div>' +
            '<p class="ws-mark-paid-status" aria-live="polite" style="margin-top:8px;"></p>';
          return;
        }
        if (e.target.classList.contains('ws-mark-paid-cancel-btn')) {
          closeDetail();
          showMembershipReportModal();
          return;
        }
        if (e.target.classList.contains('ws-mark-paid-confirm-btn')) {
          var mpcBtn = e.target;
          var markId = mpcBtn.getAttribute('data-mark-paid-id');
          var mpcWrap = mpcBtn.closest('.ws-reg-mark-paid');
          var mpcNoteEl = mpcWrap.querySelector('.ws-mark-paid-note');
          var mpcStatusEl = mpcWrap.querySelector('.ws-mark-paid-status');
          mpcStatusEl.textContent = 'Recording…';
          mpcBtn.disabled = true;
          var cred = localStorage.getItem('rw_google_credential');
          fetch('/api/tour', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cred },
            body: JSON.stringify({ kind: 'registration-mark-paid', id: parseInt(markId, 10), note: mpcNoteEl ? mpcNoteEl.value : '' })
          }).then(function (rr) { return rr.json().then(function (d) { return { ok: rr.ok, data: d }; }); })
            .then(function (rres) {
              if (!rres.ok) {
                var msg = (rres.data && rres.data.error) || 'unknown';
                if (rres.data && rres.data.youAre) msg += ' (logged in as ' + rres.data.youAre + ', expected ' + rres.data.expected + ')';
                mpcStatusEl.textContent = 'Error: ' + msg;
                mpcBtn.disabled = false;
                return;
              }
              mpcStatusEl.textContent = 'Marked Paid. Confirmation email sent.';
              setTimeout(function () {
                closeDetail();
                showMembershipReportModal();
              }, 700);
            }).catch(function (err) {
              mpcStatusEl.textContent = 'Network error: ' + ((err && err.message) || 'unknown');
              mpcBtn.disabled = false;
            });
          return;
        }
        var declineBtn = e.target.closest('.ws-decline-btn');
        if (declineBtn) {
          var id = declineBtn.getAttribute('data-decline-id');
          var name = declineBtn.getAttribute('data-decline-name');
          var email = declineBtn.getAttribute('data-decline-email');
          var wrap = declineBtn.closest('.ws-reg-decline');
          wrap.innerHTML =
            '<p class="ws-reg-decline-hint"><strong>Decline ' + escapeHtmlWs(name) + ' (' + escapeHtmlWs(email) + ')?</strong> An email goes to the family, Treasurer, Membership, and Communications. The registration row and any derived member_profiles row are deleted. Treasurer will issue the refund manually.</p>' +
            '<textarea class="rd-textarea ws-decline-note" rows="3" placeholder="Optional note to include in the decline email&hellip;"></textarea>' +
            '<div class="rd-btn-row ws-decline-btn-row">' +
              '<button type="button" class="sc-btn sc-btn-del ws-decline-confirm-btn" data-decline-id="' + escapeHtmlWs(id) + '">Confirm decline</button>' +
              '<button type="button" class="sc-btn ws-decline-cancel-btn">Cancel</button>' +
            '</div>' +
            '<p class="ws-decline-status" aria-live="polite" style="margin-top:8px;"></p>';
          return;
        }
        if (e.target.classList.contains('ws-decline-cancel-btn')) {
          // Simplest revert: close and reopen the report modal.
          closeDetail();
          showMembershipReportModal();
          return;
        }
        if (e.target.classList.contains('ws-decline-confirm-btn')) {
          var cBtn = e.target;
          var declineId = cBtn.getAttribute('data-decline-id');
          var cWrap = cBtn.closest('.ws-reg-decline');
          var noteEl = cWrap.querySelector('.ws-decline-note');
          var note = noteEl ? noteEl.value : '';
          var statusEl = cWrap.querySelector('.ws-decline-status');
          statusEl.textContent = 'Processing…';
          cBtn.disabled = true;
          var cred = localStorage.getItem('rw_google_credential');
          fetch('/api/tour', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cred },
            body: JSON.stringify({ kind: 'registration-decline', id: parseInt(declineId, 10), note: note })
          }).then(function (rr) { return rr.json().then(function (d) { return { ok: rr.ok, data: d }; }); })
            .then(function (rres) {
              if (!rres.ok) {
                statusEl.textContent = 'Error: ' + ((rres.data && rres.data.error) || 'unknown');
                cBtn.disabled = false;
                return;
              }
              statusEl.textContent = 'Declined. Decline email sent.';
              setTimeout(function () {
                closeDetail();
                showMembershipReportModal();
              }, 700);
            }).catch(function (err) {
              statusEl.textContent = 'Network error: ' + ((err && err.message) || 'unknown');
              cBtn.disabled = false;
            });
          return;
        }
      });

      renderTable();
    }).catch(function (err) {
      body.innerHTML = '<p class="ws-empty ws-wv-err">Network error loading registrations: ' + ((err && err.message) || 'unknown') + '</p>';
    });
  }

  // Full-detail panel for a single registration — shown inside an expanded
  // Membership Report row. Surfaces every field collected on the registration
  // form so the Membership Director doesn't have to dig into the DB.
  // ══════════════════════════════════════════════
  // Member Onboarding (Comms Director)
  // ══════════════════════════════════════════════
  // Phase 1: manual checklist + welcome-email queue. Comms ticks each
  // step as she finishes it in Workspace. Welcome email is gated on the
  // first two steps being done. Returning families (existing_family_name
  // set) are skipped — they already have an account. Phase 2 (full
  // automation) is parked in PARKING_LOT.md until August.

  // Same firstname+lastinitial convention used everywhere in the app
  // (api/sheets.js parseDirectory, scripts/seed-role-holders.js).
  function deriveWorkspaceEmail(mainLcName, existingFamilyName) {
    var name = String(mainLcName || '').trim();
    var parts = name.split(/\s+/);
    if (parts.length < 2) return '';
    var first = parts[0].toLowerCase().replace(/[^a-z]/g, '');
    var familyLast = String(existingFamilyName || parts[parts.length - 1]).trim();
    var lastInitial = familyLast.charAt(0).toLowerCase();
    if (!first || !lastInitial) return '';
    return first + lastInitial + '@rootsandwingsindy.com';
  }

  function isReadyToOnboard(r) {
    var paid = String(r.payment_status || '').toLowerCase() === 'paid';
    var signed = !!r.waiver_member_agreement && !!r.signature_name;
    var isNewFamily = !r.existing_family_name;
    var notDone = !r.welcome_email_sent_at;
    return paid && signed && isNewFamily && notDone;
  }

  // Empty state on the To Do card is shared across role-specific items
  // (Treasurer pending payments, Comms onboarding, Comms waivers). Show
  // "All caught up" only when every visible-by-default item ended up
  // hidden. Each loader calls this after toggling its own item.
  function recomputeTodoEmptyState() {
    var emptyEl = document.getElementById('ws-todo-empty');
    var list = document.getElementById('ws-todo-list');
    if (!emptyEl || !list) return;
    var items = list.querySelectorAll('li[id$="-item"]');
    var anyVisible = false;
    items.forEach(function (li) { if (!li.hidden) anyVisible = true; });
    emptyEl.hidden = anyVisible;
  }

  // Counts unsigned backup-coach + one-off waivers (registration signers
  // are always signed at submit so they never contribute). Same hide-
  // when-zero pattern as the other To Do loaders.
  function loadPendingWaiversCount() {
    var item = document.getElementById('ws-todo-waivers-item');
    var pill = document.getElementById('ws-waivers-count');
    var label = document.getElementById('ws-waivers-label');
    if (!item) return;
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/tour?waivers_report=1', {
      headers: { 'Authorization': 'Bearer ' + cred }
    })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; })
          .catch(function () { return { ok: r.ok, status: r.status, data: null }; });
      })
      .then(function (res) {
        if (!res.ok) {
          // Surface the auth diagnostic in the console so we can see why
          // the Pending Waivers count isn't loading. Item stays hidden.
          var msg = (res.data && res.data.error) || ('HTTP ' + res.status);
          if (res.data && res.data.youAre) msg += ' (logged in as ' + res.data.youAre + ', expected ' + res.data.expected + ')';
          console.warn('[loadPendingWaiversCount] ' + msg);
          item.hidden = true;
          recomputeTodoEmptyState();
          return;
        }
        var data = res.data || {};
        var backup = Array.isArray(data.backup) ? data.backup : [];
        var oneOff = Array.isArray(data.oneOff) ? data.oneOff : [];
        var pending = backup.filter(function (b) { return !b.signed_at; }).length
          + oneOff.filter(function (o) { return !o.signed_at; }).length;
        if (pending > 0) {
          if (label) label.textContent = 'Pending Waiver' + (pending === 1 ? '' : 's');
          if (pill) pill.textContent = String(pending);
          item.hidden = false;
        } else {
          item.hidden = true;
        }
        recomputeTodoEmptyState();
      })
      .catch(function (err) {
        console.warn('[loadPendingWaiversCount] network error:', err);
      });
  }

  function loadMemberOnboardingCount() {
    var item = document.getElementById('ws-todo-onboard-item');
    var pill = document.getElementById('ws-onboard-count');
    var label = document.getElementById('ws-onboard-label');
    if (!item) return;
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/tour?list=registrations', {
      headers: { 'Authorization': 'Bearer ' + cred }
    })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; })
          .catch(function () { return { ok: r.ok, status: r.status, data: null }; });
      })
      .then(function (res) {
        if (!res.ok) {
          var msg = (res.data && res.data.error) || ('HTTP ' + res.status);
          if (res.data && res.data.youAre) msg += ' (logged in as ' + res.data.youAre + ', expected ' + res.data.expected + ')';
          console.warn('[loadMemberOnboardingCount] ' + msg);
          item.hidden = true;
          recomputeTodoEmptyState();
          return;
        }
        var regs = Array.isArray(res.data && res.data.registrations) ? res.data.registrations : [];
        var pending = regs.filter(isReadyToOnboard).length;
        if (pending > 0) {
          if (label) label.textContent = 'New member' + (pending === 1 ? '' : 's') + ' to onboard';
          if (pill) pill.textContent = String(pending);
          item.hidden = false;
        } else {
          item.hidden = true;
        }
        recomputeTodoEmptyState();
      })
      .catch(function (err) { console.warn('[loadMemberOnboardingCount] network error:', err); });
  }

  function defaultWelcomeEmailHtml(name, workspaceEmail) {
    return [
      '<h2>Welcome to Roots &amp; Wings!</h2>',
      '<p>Hi ' + escapeHtmlWs(name) + ',</p>',
      '<p>We\'re so glad to have your family joining the co-op. Here\'s what you need to get set up.</p>',
      '<h3>Your Roots &amp; Wings Workspace account</h3>',
      '<p>Your new email address is <strong>' + escapeHtmlWs(workspaceEmail || 'your-name@rootsandwingsindy.com') + '</strong>.</p>',
      '<p>I\'ll share your <strong>temporary password</strong> with you separately for security. The first time you sign in at <a href="https://accounts.google.com">accounts.google.com</a>, Google will ask you to set your own password.</p>',
      '<h3>The Members Portal</h3>',
      '<p>Once your password is set, sign in to the members portal here:</p>',
      '<p><a href="https://roots-and-wings-topaz.vercel.app/members.html" style="display:inline-block;background:#523A79;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Open the Members Portal</a></p>',
      '<p>Inside you\'ll find the directory, schedule, calendar, member agreement &amp; waivers, your billing card, and ways to get involved.</p>',
      '<h3>Questions?</h3>',
      '<p>Reply to this email any time — it reaches me directly. Welcome aboard!</p>',
      '<p style="margin-top:24px;">— Erin Bogan, Communications Director<br>Roots &amp; Wings Homeschool, Inc.</p>'
    ].join('\n');
  }

  function showMemberOnboardingModal() {
    if (!personDetail || !personDetailCard) return;
    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail rd-modal mo-modal">';
    html += '<h3 class="rd-title">Member Onboarding</h3>';
    html += '<p class="rd-subtitle">Walk new families through their Workspace setup, then send the welcome email.</p>';
    html += '<div id="mo-body"><p class="ws-empty">Loading registrations…</p></div>';
    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) { if (e.target === personDetail) closeDetail(); });

    var body = personDetailCard.querySelector('#mo-body');
    var cred = localStorage.getItem('rw_google_credential');
    fetch('/api/tour?list=registrations', {
      headers: { 'Authorization': 'Bearer ' + cred }
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          var msg = (res.data && res.data.error) || 'error';
          if (res.data && res.data.youAre) msg += ' (logged in as ' + res.data.youAre + ', expected ' + res.data.expected + ')';
          body.innerHTML = '<p class="ws-empty ws-wv-err">Could not load: ' + msg + '</p>';
          return;
        }
        renderMemberOnboardingBody(body, res.data.registrations || []);
      }).catch(function (err) {
        body.innerHTML = '<p class="ws-empty ws-wv-err">Network error: ' + ((err && err.message) || 'unknown') + '</p>';
      });
  }

  function renderMemberOnboardingBody(body, regs) {
    var ready = regs.filter(isReadyToOnboard);

    var h = '';
    // ── Section 1: Ready to onboard ──
    h += '<section class="mo-section">';
    h += '<h4 class="mo-section-h">New families to onboard <span class="mo-pill">' + ready.length + '</span></h4>';
    if (ready.length === 0) {
      h += '<p class="ws-empty">No new families waiting on onboarding right now.</p>';
    } else {
      ready.forEach(function (r) {
        var wsEmail = deriveWorkspaceEmail(r.main_learning_coach, r.existing_family_name);
        var step1Done = !!r.workspace_account_created_at;
        var step2Done = !!r.distribution_list_added_at;
        var canSend = step1Done && step2Done;
        h += '<div class="mo-row" data-reg-id="' + r.id + '">';
        h += '<div class="mo-row-head">';
        h += '<div class="mo-row-name"><strong>' + escapeHtmlWs(r.main_learning_coach || '') + '</strong>'
          + '<span class="mo-row-sub"> &middot; ' + escapeHtmlWs(r.email || '') + '</span></div>';
        h += '<div class="mo-row-derived">Suggested Workspace email: <code>' + escapeHtmlWs(wsEmail) + '</code></div>';
        h += '</div>';
        h += '<ul class="mo-checklist">';
        h += '  <li><label><input type="checkbox" class="mo-step-cb" data-step="workspace_account_created_at" data-reg-id="' + r.id + '"' + (step1Done ? ' checked' : '') + '> 1. Workspace account created</label>'
          + (step1Done ? '<span class="mo-step-stamp"> · ' + escapeHtmlWs(new Date(r.workspace_account_created_at).toLocaleDateString()) + '</span>' : '') + '</li>';
        h += '  <li><label><input type="checkbox" class="mo-step-cb" data-step="distribution_list_added_at" data-reg-id="' + r.id + '"' + (step2Done ? ' checked' : '') + '> 2. Added to currentmembers distribution list</label>'
          + (step2Done ? '<span class="mo-step-stamp"> · ' + escapeHtmlWs(new Date(r.distribution_list_added_at).toLocaleDateString()) + '</span>' : '') + '</li>';
        h += '  <li class="mo-step-email">';
        h += '    <button type="button" class="sc-btn mo-send-email-btn" data-reg-id="' + r.id + '" data-name="' + escapeHtmlWs(r.main_learning_coach || '') + '" data-email="' + escapeHtmlWs(r.email || '') + '" data-ws-email="' + escapeHtmlWs(wsEmail) + '"' + (canSend ? '' : ' disabled') + '>3. Send welcome email&hellip;</button>';
        if (!canSend) {
          h += '    <span class="mo-row-hint">Finish steps 1 &amp; 2 first.</span>';
        }
        h += '  </li>';
        h += '</ul>';
        h += '<div class="mo-email-composer" id="mo-composer-' + r.id + '" hidden></div>';
        h += '</div>';
      });
    }
    h += '</section>';

    // ── Section 2: Pre-season removal queue ──
    var now = new Date();
    var fallDue = new Date(ACTIVE_YEAR.fallYear + '-08-27T00:00:00');
    var removalCutoff = new Date(fallDue);
    removalCutoff.setDate(removalCutoff.getDate() - 14);
    var removalActive = now >= removalCutoff;
    h += '<section class="mo-section">';
    h += '<h4 class="mo-section-h">Pre-season removal</h4>';
    if (!removalActive) {
      h += '<p class="ws-empty">Removal queue activates ' + removalCutoff.toLocaleDateString() +
        ' (2 weeks before fall classes). Until then, families who don\'t renew stay in the directory.</p>';
    } else {
      // Cross-reference FAMILIES against paid current-year regs.
      var paidEmails = {};
      regs.forEach(function (r) {
        if (String(r.payment_status || '').toLowerCase() === 'paid' && r.season === ACTIVE_YEAR.label) {
          paidEmails[String(r.email || '').toLowerCase()] = true;
        }
      });
      var candidates = (FAMILIES || []).filter(function (f) {
        if (!f || !f.email) return false;
        // Skip role mailboxes — they're not tied to a single family.
        if (/^(membership|treasurer|secretary|president|vp|vicepresident|sustaining|communications|fundraising|webhost|yearbook)@/i.test(f.email)) return false;
        return !paidEmails[String(f.email).toLowerCase()];
      });
      if (candidates.length === 0) {
        h += '<p class="ws-empty">Every family has renewed for ' + escapeHtmlWs(ACTIVE_YEAR.label) + '. 🎉</p>';
      } else {
        h += '<p class="mo-removal-hint">' + candidates.length + ' famil' + (candidates.length === 1 ? 'y' : 'ies') + ' in the directory without a paid ' + escapeHtmlWs(ACTIVE_YEAR.label) + ' registration. Remove from Workspace, distribution list, then directory sheet — they\'ll drop off this list automatically once they\'re out of the directory.</p>';
        h += '<ul class="mo-removal-list">';
        candidates.forEach(function (f) {
          h += '<li><strong>' + escapeHtmlWs(f.name || '') + '</strong> family &middot; ' + escapeHtmlWs(f.email || '') + '</li>';
        });
        h += '</ul>';
      }
    }
    h += '</section>';

    body.innerHTML = h;
    wireMemberOnboardingHandlers(body);
  }

  function wireMemberOnboardingHandlers(body) {
    body.querySelectorAll('.mo-step-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = parseInt(this.getAttribute('data-reg-id'), 10);
        var field = this.getAttribute('data-step');
        var done = this.checked;
        var that = this;
        that.disabled = true;
        var cred = localStorage.getItem('rw_google_credential');
        fetch('/api/tour', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cred },
          body: JSON.stringify({ kind: 'onboarding-step', id: id, field: field, done: done })
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
          .then(function (res) {
            if (!res.ok) {
              alert((res.data && res.data.error) || 'Could not update step.');
              that.checked = !done;
              that.disabled = false;
              return;
            }
            // Re-render the modal so the Send-Email button enables and stamps appear.
            closeDetail();
            showMemberOnboardingModal();
          }).catch(function () {
            alert('Network error.');
            that.checked = !done;
            that.disabled = false;
          });
      });
    });

    body.querySelectorAll('.mo-send-email-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (this.disabled) return;
        var id = parseInt(this.getAttribute('data-reg-id'), 10);
        var name = this.getAttribute('data-name');
        var emailTo = this.getAttribute('data-email');
        var wsEmail = this.getAttribute('data-ws-email');
        var composer = document.getElementById('mo-composer-' + id);
        if (!composer) return;
        var subject = 'Welcome to Roots & Wings — your member portal access';
        var bodyHtml = defaultWelcomeEmailHtml(name, wsEmail);
        var ch = '<div class="mo-composer-inner">';
        ch += '<p class="mo-composer-info">Sending to <strong>' + escapeHtmlWs(emailTo) + '</strong> · cc Communications</p>';
        ch += '<label class="mo-composer-label">Subject</label>';
        ch += '<input type="text" class="cl-input mo-composer-subject" value="' + escapeHtmlWs(subject) + '">';
        ch += '<label class="mo-composer-label">Email body (HTML — edit if you need to swap in the real Workspace email or notes)</label>';
        ch += '<textarea class="rd-textarea mo-composer-body" rows="14">' + escapeHtmlWs(bodyHtml) + '</textarea>';
        ch += '<div class="rd-btn-row mo-composer-actions">';
        ch += '<button type="button" class="sc-btn mo-composer-send" data-reg-id="' + id + '">Send welcome email</button>';
        ch += '<button type="button" class="sc-btn mo-composer-cancel">Cancel</button>';
        ch += '</div>';
        ch += '<p class="mo-composer-status" aria-live="polite"></p>';
        ch += '</div>';
        composer.innerHTML = ch;
        composer.hidden = false;
        // Don't textarea-encode the HTML twice — the textarea displays
        // the escaped form which is what we want, but on send we need the
        // original. Re-set value via property to bypass HTML parse.
        composer.querySelector('.mo-composer-body').value = bodyHtml;

        composer.querySelector('.mo-composer-cancel').addEventListener('click', function () {
          composer.hidden = true;
          composer.innerHTML = '';
        });
        composer.querySelector('.mo-composer-send').addEventListener('click', function () {
          var sendBtn = this;
          var statusEl = composer.querySelector('.mo-composer-status');
          var subj = composer.querySelector('.mo-composer-subject').value;
          var bod = composer.querySelector('.mo-composer-body').value;
          if (!subj.trim() || !bod.trim()) {
            statusEl.textContent = 'Subject and body are required.';
            return;
          }
          sendBtn.disabled = true;
          statusEl.textContent = 'Sending…';
          var cred = localStorage.getItem('rw_google_credential');
          fetch('/api/tour', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cred },
            body: JSON.stringify({ kind: 'send-welcome-email', id: id, subject: subj, html: bod })
          }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (res) {
              if (!res.ok) {
                var msg = (res.data && res.data.error) || 'unknown';
                if (res.data && res.data.youAre) msg += ' (logged in as ' + res.data.youAre + ', expected ' + res.data.expected + ')';
                statusEl.textContent = 'Error: ' + msg;
                sendBtn.disabled = false;
                return;
              }
              statusEl.textContent = 'Sent — family will get the email shortly.';
              setTimeout(function () {
                closeDetail();
                showMemberOnboardingModal();
              }, 700);
            }).catch(function (err) {
              statusEl.textContent = 'Network error: ' + ((err && err.message) || 'unknown');
              sendBtn.disabled = false;
            });
        });
      });
    });
  }

  function renderMembershipRegDetail(r) {
    function fld(label, val) {
      return '<div class="ws-reg-detail-field"><span class="ws-reg-detail-label">' + escapeHtmlWs(label) + '</span><span class="ws-reg-detail-val">' + (val || '<em>\u2014</em>') + '</span></div>';
    }
    function yn(v) { return v ? '<span class="ws-wv-ok">Yes</span>' : '<span class="ws-wv-pending">No</span>'; }

    var kidsHtml = '';
    if (r.kids && r.kids.length) {
      kidsHtml = '<ul class="ws-reg-detail-kidlist">';
      r.kids.forEach(function (k) {
        var row = '<strong>' + escapeHtmlWs(k.name || '') + '</strong>';
        if (k.birth_date || k.birthdate) row += ' \u00b7 born ' + escapeHtmlWs(k.birth_date || k.birthdate);
        if (k.group) row += ' \u00b7 ' + escapeHtmlWs(k.group);
        if (k.notes) row += '<br><em>' + escapeHtmlWs(k.notes) + '</em>';
        kidsHtml += '<li>' + row + '</li>';
      });
      kidsHtml += '</ul>';
    } else {
      kidsHtml = '<em>None listed</em>';
    }

    var backupsHtml = '';
    if (r.backup_coaches && r.backup_coaches.length) {
      backupsHtml = '<ul class="ws-reg-detail-kidlist">';
      r.backup_coaches.forEach(function (b) {
        var line = '<strong>' + escapeHtmlWs(b.name || '') + '</strong> \u2014 ' + escapeHtmlWs(b.email || '');
        if (b.signed_at) {
          line += ' \u00b7 <span class="ws-wv-ok">Signed ' + new Date(b.signed_at).toLocaleDateString() + '</span>';
          if (b.signature_name) line += ' by ' + escapeHtmlWs(b.signature_name);
        } else if (b.sent_at) {
          line += ' \u00b7 <span class="ws-wv-pending">Sent ' + new Date(b.sent_at).toLocaleDateString() + ' \u2014 pending</span>';
        }
        backupsHtml += '<li>' + line + '</li>';
      });
      backupsHtml += '</ul>';
    } else {
      backupsHtml = '<em>None listed</em>';
    }

    var track = r.track || '';
    if (r.track === 'Other' && r.track_other) track = 'Other: ' + r.track_other;

    var h = '<div class="ws-reg-detail-grid">';
    h += fld('Season', escapeHtmlWs(r.season));
    h += fld('Registered', r.created_at ? escapeHtmlWs(new Date(r.created_at).toLocaleString()) : '');
    h += fld('Returning family', r.existing_family_name ? escapeHtmlWs(r.existing_family_name) : '<em>(new)</em>');
    h += fld('Main Learning Coach', escapeHtmlWs(r.main_learning_coach));
    h += fld('Email', '<a href="mailto:' + escapeHtmlWs(r.email) + '">' + escapeHtmlWs(r.email) + '</a>');
    h += fld('Phone', escapeHtmlWs(r.phone));
    h += fld('Address', escapeHtmlWs(r.address));
    h += fld('Track', escapeHtmlWs(track));
    h += '</div>';

    h += '<div class="ws-reg-detail-section"><h5>Children</h5>' + kidsHtml + '</div>';
    h += '<div class="ws-reg-detail-section"><h5>Backup Learning Coaches</h5>' + backupsHtml + '</div>';

    h += '<div class="ws-reg-detail-grid">';
    h += fld('Member Agreement', yn(r.waiver_member_agreement));
    h += fld('Liability Waiver', yn(r.waiver_liability));
    h += fld('Photo Consent', r.waiver_photo_consent ? escapeHtmlWs(r.waiver_photo_consent) : '<em>\u2014</em>');
    h += fld('Signature', escapeHtmlWs(r.signature_name) + (r.signature_date ? ' on ' + escapeHtmlWs(r.signature_date) : ''));
    if (r.student_signature) h += fld('Adult student signatures', escapeHtmlWs(r.student_signature));
    h += fld('Payment status', escapeHtmlWs(r.payment_status));
    h += fld('Payment amount', r.payment_amount != null ? '$' + escapeHtmlWs(r.payment_amount) : '<em>\u2014</em>');
    h += fld('PayPal transaction', escapeHtmlWs(r.paypal_transaction_id));
    h += '</div>';

    if (r.placement_notes) {
      h += '<div class="ws-reg-detail-section"><h5>Placement notes</h5><div class="ws-reg-detail-notes">' + escapeHtmlWs(r.placement_notes) + '</div></div>';
    }

    // Treasurer-only action: mark a pending cash/check registration as paid.
    // Server enforces the role gate (Treasurer or super user). Client gate
    // checks isTreasurer() — which respects View-As, so communications@
    // sees the button after View-As'ing into the Treasurer (matches
    // Erin's "Comms gets read-only Membership Report" intent).
    var isPending = String(r.payment_status || '').toLowerCase() !== 'paid';
    if (isPending && isTreasurer()) {
      h += '<div class="ws-reg-detail-section ws-reg-mark-paid">';
      h += '<button type="button" class="sc-btn ws-mark-paid-btn" data-mark-paid-id="' + escapeHtmlWs(String(r.id)) + '" data-mark-paid-name="' + escapeHtmlWs(r.main_learning_coach || '') + '" data-mark-paid-email="' + escapeHtmlWs(r.email || '') + '">Mark payment received&hellip;</button>';
      h += '<p class="ws-reg-decline-hint">Records the cash/check payment, flips the family\'s My Family billing card to Paid, and emails the family + Membership + Communications a payment-received confirmation.</p>';
      h += '</div>';
    }

    // Membership-only action. Renders here so it sits at the bottom of the
    // expanded detail, away from casual clicks. Wired via delegated listener
    // below (see ws-membership-report-body click handler). Hidden from
    // Treasurer / Comms now that they also see the report.
    if (isMembershipDirector()) {
      h += '<div class="ws-reg-detail-section ws-reg-decline">';
      h += '<button type="button" class="sc-btn sc-btn-del ws-decline-btn" data-decline-id="' + escapeHtmlWs(String(r.id)) + '" data-decline-name="' + escapeHtmlWs(r.main_learning_coach || '') + '" data-decline-email="' + escapeHtmlWs(r.email || '') + '">Decline registration…</button>';
      h += '<p class="ws-reg-decline-hint">Deletes the registration, emails the family + Treasurer + Membership + Communications, and frees up the refund for the Treasurer to process.</p>';
      h += '</div>';
    }
    return h;
  }

  // ══════════════════════════════════════════════
  // Personal Participation Badge (all authed members)
  // ══════════════════════════════════════════════
  // A small growing-plant icon in the greeting strip showing how the active
  // member is tracking against their year-to-date participation score. The
  // same icon advances from sprout → sapling → tree as contributions grow.
  // Click jumps to Workspace → Ways to Help for the full breakdown + open
  // seats. Backend: /api/sheets?action=participation-mine&email=<active>;
  // the super user's View As picker sets the email automatically.

  var _participationMine = null;        // { season, member, tier }
  var _participationMineEmail = null;   // active email the cache is keyed to
  var _participationBadgeWired = false;

  // One icon, three growth stages. Uses currentColor so CSS tinting picks it
  // up from the theme palette (coral / gold / leaf-green).
  var PLANT_SVGS = {
    sprout:
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 22v-6"/>' +
      '<path d="M12 16c-3.5 0-5-2.5-5-5.5 3.5 0 5 2.5 5 5.5z"/>' +
      '<path d="M12 14c3.5 0 5-2.5 5-5.5-3.5 0-5 2.5-5 5.5z"/>' +
      '</svg>',
    sapling:
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 22V10"/>' +
      '<path d="M12 14c-4 0-6-3-6-7 4 0 6 3 6 7z"/>' +
      '<path d="M12 12c4 0 6-3 6-7-4 0-6 3-6 7z"/>' +
      '<path d="M12 18c-2.5 0-4-1.5-4-4 2.5 0 4 1.5 4 4z"/>' +
      '</svg>',
    tree:
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 22v-7"/>' +
      '<path d="M12 15c-5 0-8-3.5-7-8.5 4 0 7 3 7 8.5z"/>' +
      '<path d="M12 15c5 0 8-3.5 7-8.5-4 0-7 3-7 8.5z"/>' +
      '<path d="M12 11c-3.5 0-5.5-2-4.5-5.5 3 0 5 2 4.5 5.5z"/>' +
      '<path d="M12 11c3.5 0 5.5-2 4.5-5.5-3 0-5 2-4.5 5.5z"/>' +
      '</svg>'
  };

  var PLANT_TOOLTIPS = {
    sprout:  'Just getting started — tap to see ways to jump in.',
    sapling: 'You’re well on your way this year — tap for more ways to help.',
    tree:    'You’re a cornerstone of our co-op this year. Thank you! Tap to see your year so far.'
  };

  // Derive the 3-tier growth stage client-side from the member row.
  // The icon MUST match the numbers the user sees in the panel, so the
  // raw weightedTotal vs. expectedPoints comparison is authoritative —
  // if the server's pre-computed status string disagrees (stale, racy,
  // edge-case in the bucket logic) we still render the correct tier.
  function deriveParticipationTier(member) {
    if (!member) return 'sprout';
    var t = Number(member.weightedTotal) || 0;
    var e = Number(member.expectedPoints) || 0;
    // Exempt: expected collapses to ~0 during an exemption — render tree
    // so members taking a break don't feel nudged.
    if (e < 0.5 && member.exemption) return 'tree';
    if (e > 0) {
      if (t >= e) return 'tree';
      if (t >= e * 0.8) return 'sapling';
      return 'sprout';
    }
    // Only if we have no expected points at all do we fall back to the
    // status string (which could itself still be missing).
    var status = member.status || '';
    if (status === 'on_track' || status === 'exempt') return 'tree';
    if (status === 'near') return 'sapling';
    return 'sprout';
  }

  function renderParticipationBadge() {
    var btn = document.getElementById('qsbPlantBadge');
    var iconEl = document.getElementById('qsbPlantIcon');
    if (!btn || !iconEl) return;
    var member = _participationMine && _participationMine.member;
    if (!member) { btn.hidden = true; return; }
    var tier = deriveParticipationTier(member);
    btn.hidden = false;
    btn.classList.remove('plant-sprout', 'plant-sapling', 'plant-tree');
    btn.classList.add('plant-' + tier);
    iconEl.innerHTML = PLANT_SVGS[tier] || PLANT_SVGS.sprout;
    var tip = PLANT_TOOLTIPS[tier] || '';
    btn.title = tip;
    btn.setAttribute('aria-label', tip || 'Your participation this year');
  }

  function wireParticipationBadge() {
    if (_participationBadgeWired) return;
    var btn = document.getElementById('qsbPlantBadge');
    if (!btn) return;
    _participationBadgeWired = true;
    btn.addEventListener('click', function () {
      var wsPill = document.querySelector('.qsb-pill[data-view="workspace"]');
      if (wsPill) wsPill.click();
      // Scroll the Ways to Help card into view once the workspace renders.
      setTimeout(function () {
        var card = document.querySelector('[data-widget-type="ways-to-help"]');
        if (card && card.scrollIntoView) {
          card.scrollIntoView({ behavior: 'smooth', block: 'start' });
          card.classList.add('ws-card-flash');
          setTimeout(function () { card.classList.remove('ws-card-flash'); }, 1600);
        }
      }, 80);
    });
  }

  function loadParticipationBadge() {
    wireParticipationBadge();
    var email = getActiveEmail();
    var cred = localStorage.getItem('rw_google_credential');
    if (!email || !cred) {
      _participationMine = null;
      _participationMineEmail = null;
      renderParticipationBadge();
      return;
    }
    // Already fetched for this email — just re-render. renderMyFamily calls
    // us on every re-render; the fetch runs only when the active email
    // changes (login, View As switch, or logout/reswitch).
    if (_participationMineEmail === email && _participationMine) {
      renderParticipationBadge();
      return;
    }
    _participationMineEmail = email;
    fetch('/api/sheets?action=participation-mine&email=' + encodeURIComponent(email), {
      headers: { 'Authorization': 'Bearer ' + cred }
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || _participationMineEmail !== email) return; // stale response
        _participationMine = data;
        // Temporary diagnostic: surface status/tier/totals on the badge as
        // data-* attributes + a console.debug line. Lets us eyeball why a
        // given member lands on sprout vs. tree without guessing.
        try {
          var m = data.member || {};
          console.debug('[participation-mine] status=' + m.status + ' tier=' + m.tier +
            ' weightedTotal=' + m.weightedTotal + ' expectedPoints=' + m.expectedPoints +
            ' isNewMember=' + m.isNewMember + ' exemption=' + (m.exemption ? 'yes' : 'no') +
            ' first=' + m.first);
          var badgeEl = document.getElementById('qsbPlantBadge');
          if (badgeEl) {
            badgeEl.dataset.status = m.status || '';
            badgeEl.dataset.tier = m.tier || '';
            badgeEl.dataset.total = String(m.weightedTotal);
            badgeEl.dataset.expected = String(m.expectedPoints);
          }
        } catch (e) { /* ignore */ }
        renderParticipationBadge();
        // If Ways to Help is currently on-screen, refresh so the panel
        // picks up the new data without requiring a tab bounce.
        var wsPanel = document.getElementById('page-workspace');
        if (wsPanel && wsPanel.style.display !== 'none' &&
            typeof renderWorkspaceTab === 'function') {
          renderWorkspaceTab();
        }
      })
      .catch(function () { /* silent — badge stays hidden on error */ });
  }

  // ══════════════════════════════════════════════
  // Participation Tracker (VP / Afternoon Class Liaison / super user)
  // ══════════════════════════════════════════════
  // Backend: /api/sheets?action=participation-* (gated server-side against
  // the volunteer sheet role holders; this UI just mirrors that gate).

  var PARTICIPATION_COUNT_FIELDS = [
    { key: 'board_role',       label: 'Board' },
    { key: 'one_year_role',    label: '1-yr Role' },
    { key: 'am_lead',          label: 'AM Lead' },
    { key: 'am_assist',        label: 'AM Assist' },
    { key: 'pm_lead',          label: 'PM Lead' },
    { key: 'pm_assist',        label: 'PM Assist' },
    { key: 'cleaning_session', label: 'Cleaning' },
    { key: 'event_lead',       label: 'Event Lead' },
    { key: 'event_assist',     label: 'Event Assist' }
  ];

  var PARTICIPATION_STATUS_LABELS = {
    on_track: 'On track',
    near:     'Close',
    behind:   'Behind',
    'new':    'New',
    exempt:   'Exempt'
  };

  function participationCanWrite() {
    // VP or super user (communications@) — backend re-checks. The super-user
    // shortcut lets communications@ act as VP for the report.
    if (isCommsUser()) return true;
    return isVP();
  }

  function showParticipationReportModal() {
    if (!personDetail || !personDetailCard) return;
    var canWrite = participationCanWrite();
    var html = '<div class="detail-actions no-print">';
    if (canWrite) {
      html += '<button class="sc-btn" type="button" data-part-action="weights" aria-label="Edit the weights used in the participation score">⚙️ Weights</button>';
      html += '<button class="sc-btn" type="button" data-part-action="exemptions" aria-label="Add or edit health/family exemptions">🩺 Exemptions</button>';
    }
    html += '<button class="sc-btn" type="button" data-part-action="csv" aria-label="Download the full report as CSV">⬇️ Export CSV</button>';
    html += '<button class="sc-btn" type="button" data-part-action="print" aria-label="Print the report">🖨️ Print</button>';
    html += '</div>';
    html += '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail rd-modal">';
    html += '<h3 class="rd-title">Member Participation Tracker</h3>';
    html += '<p class="rd-subtitle">Session-slot counts for every member this school year. Click a row for the session-by-session breakdown.</p>';
    html += '<div id="ws-participation-body"><p class="ws-empty">Loading participation data…</p></div>';
    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) { if (e.target === personDetail) closeDetail(); });

    personDetailCard.querySelectorAll('[data-part-action]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var a = this.getAttribute('data-part-action');
        if (a === 'weights') showParticipationWeightsModal();
        else if (a === 'exemptions') showParticipationExemptionsModal();
        else if (a === 'csv') exportParticipationCSV();
        else if (a === 'print') printParticipationReport();
      });
    });

    loadParticipationReport();
  }

  // In-memory cache of the most recently loaded report, so CSV/print and
  // the drill-down modal don't have to re-fetch.
  var _participationReport = null;

  function loadParticipationReport() {
    var body = personDetailCard && personDetailCard.querySelector('#ws-participation-body');
    if (!body) return;
    var cred = localStorage.getItem('rw_google_credential');
    fetch('/api/sheets?action=participation-report', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + cred }
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
    .then(function (res) {
      if (!res.ok) {
        var msg = (res.data && res.data.error) || 'error';
        body.innerHTML = '<p class="ws-empty ws-wv-err">Could not load: ' + escapeHtmlWs(msg) + '</p>';
        return;
      }
      _participationReport = res.data;
      renderParticipationReport();
    }).catch(function (err) {
      body.innerHTML = '<p class="ws-empty ws-wv-err">Network error: ' + escapeHtmlWs((err && err.message) || 'unknown') + '</p>';
    });
  }

  function renderParticipationReport() {
    var body = personDetailCard && personDetailCard.querySelector('#ws-participation-body');
    if (!body || !_participationReport) return;
    var members = _participationReport.members || [];
    var season = _participationReport.season || '';
    var statusCounts = { on_track: 0, near: 0, behind: 0, 'new': 0, exempt: 0 };
    members.forEach(function (m) {
      // Anyone with an active exemption counts under "exempt" regardless of
      // where their weighted score landed — matches the filter below.
      var bucket = m.exemption ? 'exempt' : m.status;
      if (statusCounts[bucket] != null) statusCounts[bucket] += 1;
    });

    var headerHtml = '<p class="ws-body-hint"><strong>' + members.length + '</strong> members · Season <strong>' + escapeHtmlWs(season) + '</strong>'
      + ' · <strong class="ws-wv-ok">' + statusCounts.on_track + ' on track</strong>'
      + ' · <strong class="ws-wv-pending">' + statusCounts.near + ' close</strong>'
      + ' · <strong class="ws-wv-err">' + statusCounts.behind + ' behind</strong>'
      + ' · <strong>' + statusCounts['new'] + ' new</strong>'
      + ' · <strong>' + statusCounts.exempt + ' exempt</strong>'
      + '</p>';

    // Status filter chips
    var filterHtml = '<div class="ws-part-filter">Filter: '
      + '<button type="button" class="sc-btn ws-part-filter-btn ws-part-filter-active" data-filter="all">All</button>'
      + '<button type="button" class="sc-btn ws-part-filter-btn" data-filter="behind">Behind</button>'
      + '<button type="button" class="sc-btn ws-part-filter-btn" data-filter="near">Close</button>'
      + '<button type="button" class="sc-btn ws-part-filter-btn" data-filter="new">New</button>'
      + '<button type="button" class="sc-btn ws-part-filter-btn" data-filter="exempt">Exempt</button>'
      + '<button type="button" class="sc-btn ws-part-filter-btn" data-filter="on_track">On track</button>'
      + '</div>';

    body.innerHTML = headerHtml + filterHtml + '<div id="ws-part-table-target"></div>';

    var currentFilter = 'all';
    function filteredRows() {
      if (currentFilter === 'all') return members;
      if (currentFilter === 'exempt') {
        return members.filter(function (m) { return !!m.exemption; });
      }
      // Non-exempt buckets: skip members with an active exemption so they
      // only surface under "Exempt".
      return members.filter(function (m) { return !m.exemption && m.status === currentFilter; });
    }

    function renderTable() {
      var tableTarget = body.querySelector('#ws-part-table-target');
      if (!tableTarget) return;
      renderSortableTable(tableTarget, participationTableColumns(), filteredRows(), {
        initialSort: { key: 'weightedTotal', dir: 'desc' },
        expandable: true,
        renderDetail: renderParticipationTimeline
      });
    }

    body.querySelectorAll('.ws-part-filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        body.querySelectorAll('.ws-part-filter-btn').forEach(function (b) { b.classList.remove('ws-part-filter-active'); });
        this.classList.add('ws-part-filter-active');
        currentFilter = this.getAttribute('data-filter');
        renderTable();
      });
    });
    renderTable();
  }

  function participationTableColumns() {
    var cols = [
      { key: 'displayName', label: 'Member', type: 'string',
        sortValue: function (r) { return (r.family + ' ' + r.first).toLowerCase(); },
        render: function (r) {
          var badges = '';
          if (r.isBoard) badges += ' <span class="ws-part-badge ws-part-badge-board">Board</span>';
          if (r.isNewMember) badges += ' <span class="ws-part-badge ws-part-badge-new">New</span>';
          if (r.exemption) badges += ' <span class="ws-part-badge ws-part-badge-exempt">Exempt</span>';
          return '<strong>' + escapeHtmlWs(r.displayName) + '</strong>' + badges;
        }
      }
    ];
    PARTICIPATION_COUNT_FIELDS.forEach(function (f) {
      cols.push({
        key: f.key, label: f.label, type: 'number',
        sortValue: function (r) { return r.counts[f.key] || 0; },
        render: function (r) {
          var v = r.counts[f.key] || 0;
          return v > 0 ? String(v) : '<span class="ws-part-zero">–</span>';
        }
      });
    });
    cols.push({
      key: 'weightedTotal', label: 'Weighted', type: 'number',
      render: function (r) { return '<strong>' + (r.weightedTotal || 0) + '</strong>'; }
    });
    cols.push({
      key: 'expectedPoints', label: 'Expected', type: 'number',
      render: function (r) { return String(r.expectedPoints || 0); }
    });
    cols.push({
      key: 'coverageGiven', label: 'Coverage Given', type: 'number',
      render: function (r) {
        var v = r.coverageGiven || 0;
        return v > 0 ? String(v) : '<span class="ws-part-zero">–</span>';
      }
    });
    cols.push({
      key: 'status', label: 'Status', type: 'string',
      sortValue: function (r) {
        // Behind first, then near, new, on-track, exempt last
        var order = { behind: 0, near: 1, 'new': 2, on_track: 3, exempt: 4 };
        return String(order[r.status] != null ? order[r.status] : 5);
      },
      render: function (r) {
        var cls = 'ws-part-status ws-part-status-' + r.status;
        return '<span class="' + cls + '">' + escapeHtmlWs(PARTICIPATION_STATUS_LABELS[r.status] || r.status) + '</span>';
      }
    });
    return cols;
  }

  function renderParticipationTimeline(r) {
    var h = '<div class="ws-part-timeline">';
    if (r.roles && r.roles.length) {
      h += '<div class="ws-part-roles"><strong>Roles this year:</strong> ' + r.roles.map(escapeHtmlWs).join(' · ') + '</div>';
    }
    if (r.exemption) {
      h += '<div class="ws-part-exemption"><strong>Active exemption:</strong> '
        + escapeHtmlWs(r.exemption.reason)
        + ' · ' + escapeHtmlWs(r.exemption.start_date)
        + (r.exemption.end_date ? ' → ' + escapeHtmlWs(r.exemption.end_date) : ' → ongoing')
        + (r.exemption.note ? ' — <em>' + escapeHtmlWs(r.exemption.note) + '</em>' : '')
        + '</div>';
    }
    var anySessions = false;
    for (var s = 1; s <= 5; s++) {
      var entries = (r.timeline && r.timeline[s]) || [];
      if (entries.length === 0) continue;
      anySessions = true;
      h += '<div class="ws-part-session"><h5>Session ' + s + '</h5><ul>';
      entries.forEach(function (e) {
        h += '<li>' + escapeHtmlWs(e.label) + '</li>';
      });
      h += '</ul></div>';
    }
    if (!anySessions) {
      h += '<p class="ws-empty">No session-slot assignments recorded yet.</p>';
    }
    if (r.coverageGiven) {
      h += '<p class="ws-part-coverage-note"><em>Coverage given: ' + r.coverageGiven + ' slot(s) stepped into for absent members. Not counted toward the weighted total.</em></p>';
    }
    if (r.absencesCount) {
      h += '<p class="ws-part-coverage-note"><em>Absences logged: ' + r.absencesCount + '.</em></p>';
    }
    h += '</div>';
    return h;
  }

  // ─── Weights admin (VP / super user only) ───
  function showParticipationWeightsModal() {
    if (!personDetail || !personDetailCard) return;
    if (!participationCanWrite()) { alert('Vice President or super user only.'); return; }
    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail rd-modal">';
    html += '<h3 class="rd-title">Participation Weights</h3>';
    html += '<p class="rd-subtitle">These values are the points each session-slot contributes to the weighted score. Adjust as needed; the report recomputes on save.</p>';
    html += '<div id="ws-part-weights-body"><p class="ws-empty">Loading weights…</p></div>';
    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', function () {
      // Return to the report view with fresh data
      showParticipationReportModal();
    });
    personDetail.addEventListener('click', function (e) { if (e.target === personDetail) closeDetail(); });

    var cred = localStorage.getItem('rw_google_credential');
    fetch('/api/sheets?action=participation-weights', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + cred }
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
    .then(function (res) {
      var body = personDetailCard.querySelector('#ws-part-weights-body');
      if (!res.ok) { body.innerHTML = '<p class="ws-empty ws-wv-err">' + escapeHtmlWs((res.data && res.data.error) || 'error') + '</p>'; return; }
      var weights = (res.data && res.data.weights) || [];
      if (weights.length === 0) { body.innerHTML = '<p class="ws-empty">No weights configured.</p>'; return; }
      var h = '<table class="ws-part-weights-table"><thead><tr><th>Label</th><th>Value</th><th></th></tr></thead><tbody>';
      weights.forEach(function (w) {
        h += '<tr data-weight-key="' + escapeHtmlWs(w.key) + '">'
          + '<td><strong>' + escapeHtmlWs(w.label) + '</strong>'
          + (w.description ? '<br><span class="ws-part-weight-desc">' + escapeHtmlWs(w.description) + '</span>' : '')
          + '</td>'
          + '<td><input type="number" step="0.25" class="ws-part-weight-input" value="' + escapeHtmlWs(w.value) + '" /></td>'
          + '<td><button type="button" class="btn btn-primary btn-sm ws-part-weight-save">Save</button>'
          + '<span class="ws-part-weight-status"></span></td>'
          + '</tr>';
      });
      h += '</tbody></table>';
      body.innerHTML = h;

      body.querySelectorAll('.ws-part-weight-save').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var row = this.closest('tr');
          var key = row.getAttribute('data-weight-key');
          var input = row.querySelector('.ws-part-weight-input');
          var statusEl = row.querySelector('.ws-part-weight-status');
          var value = parseFloat(input.value);
          if (!isFinite(value)) { statusEl.className = 'ws-part-weight-status ws-wv-err'; statusEl.textContent = 'Not a number'; return; }
          var orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
          statusEl.textContent = '';
          fetch('/api/sheets?action=participation-weight-save', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: key, value: value })
          }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
          .then(function (res2) {
            btn.disabled = false; btn.textContent = orig;
            if (!res2.ok) { statusEl.className = 'ws-part-weight-status ws-wv-err'; statusEl.textContent = (res2.data && res2.data.error) || 'Save failed'; return; }
            statusEl.className = 'ws-part-weight-status ws-wv-ok'; statusEl.textContent = 'Saved';
          }).catch(function (err) {
            btn.disabled = false; btn.textContent = orig;
            statusEl.className = 'ws-part-weight-status ws-wv-err'; statusEl.textContent = (err && err.message) || 'Network error';
          });
        });
      });
    });
  }

  // ─── Exemptions admin (VP / super user only) ───
  function showParticipationExemptionsModal() {
    if (!personDetail || !personDetailCard) return;
    if (!participationCanWrite()) { alert('Vice President or super user only.'); return; }
    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail rd-modal">';
    html += '<h3 class="rd-title">Participation Exemptions</h3>';
    html += '<p class="rd-subtitle">Health / family leave pro-rates a member’s expected points. Leave end date blank for ongoing.</p>';
    html += '<div id="ws-part-exempt-body"><p class="ws-empty">Loading…</p></div>';
    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', function () {
      showParticipationReportModal();
    });
    personDetail.addEventListener('click', function (e) { if (e.target === personDetail) closeDetail(); });

    loadParticipationExemptions();
  }

  function loadParticipationExemptions() {
    var body = personDetailCard && personDetailCard.querySelector('#ws-part-exempt-body');
    if (!body) return;
    var cred = localStorage.getItem('rw_google_credential');
    fetch('/api/sheets?action=participation-exemptions', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + cred }
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
    .then(function (res) {
      if (!res.ok) { body.innerHTML = '<p class="ws-empty ws-wv-err">' + escapeHtmlWs((res.data && res.data.error) || 'error') + '</p>'; return; }
      var list = (res.data && res.data.exemptions) || [];
      var h = '<div class="ws-part-exempt-form"><h5>Add / Edit</h5>';
      h += participationExemptionFormHtml(null);
      h += '</div>';
      h += '<h5 class="ws-part-exempt-existing">Current & past exemptions</h5>';
      if (list.length === 0) {
        h += '<p class="ws-empty">No exemptions on file.</p>';
      } else {
        h += '<table class="ws-part-exempt-table"><thead><tr><th>Member</th><th>Window</th><th>Reason</th><th>Note</th><th></th></tr></thead><tbody>';
        list.forEach(function (e) {
          h += '<tr data-exempt-id="' + escapeHtmlWs(e.id) + '">'
            + '<td><strong>' + escapeHtmlWs(e.member_name) + '</strong><br><span class="ws-part-weight-desc">' + escapeHtmlWs(e.member_email) + '</span></td>'
            + '<td>' + escapeHtmlWs(e.start_date) + ' → ' + (e.end_date ? escapeHtmlWs(e.end_date) : 'ongoing') + '</td>'
            + '<td>' + escapeHtmlWs(e.reason) + '</td>'
            + '<td>' + escapeHtmlWs(e.note || '') + '</td>'
            + '<td>'
            + '<button type="button" class="sc-btn ws-part-exempt-edit">Edit</button> '
            + '<button type="button" class="sc-btn sc-btn-del ws-part-exempt-delete">Delete</button>'
            + '</td></tr>';
        });
        h += '</tbody></table>';
      }
      body.innerHTML = h;

      wireParticipationExemptionForm(body, null);

      body.querySelectorAll('.ws-part-exempt-edit').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var row = this.closest('tr');
          var id = row.getAttribute('data-exempt-id');
          var target = list.filter(function (x) { return String(x.id) === String(id); })[0];
          if (!target) return;
          var form = body.querySelector('.ws-part-exempt-form');
          form.innerHTML = '<h5>Edit exemption</h5>' + participationExemptionFormHtml(target);
          wireParticipationExemptionForm(body, target);
        });
      });

      body.querySelectorAll('.ws-part-exempt-delete').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var row = this.closest('tr');
          var id = row.getAttribute('data-exempt-id');
          if (!confirm('Delete this exemption?')) return;
          fetch('/api/sheets?action=participation-exemption-delete', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: parseInt(id, 10) })
          }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
          .then(function (res2) {
            if (!res2.ok) { alert((res2.data && res2.data.error) || 'Delete failed'); return; }
            loadParticipationExemptions();
          });
        });
      });
    });
  }

  function participationExemptionFormHtml(existing) {
    existing = existing || {};
    var members = (_participationReport && _participationReport.members) || [];
    var opts = '<option value="">— pick a member —</option>';
    members.forEach(function (m) {
      var sel = (existing.member_email && existing.member_email.toLowerCase() === (m.email || '').toLowerCase()
                 && existing.member_name === m.displayName) ? ' selected' : '';
      opts += '<option value="' + escapeHtmlWs(m.email) + '|' + escapeHtmlWs(m.displayName) + '"' + sel + '>'
        + escapeHtmlWs(m.displayName) + '</option>';
    });
    var reasonOpts = ['medical', 'family', 'other'].map(function (r) {
      return '<option value="' + r + '"' + (existing.reason === r ? ' selected' : '') + '>' + r + '</option>';
    }).join('');
    var h = '<div class="ws-waiver-form">';
    h += '<label>Member<select class="ws-part-exempt-member">' + opts + '</select></label>';
    h += '<label>Start date<input type="date" class="ws-part-exempt-start" value="' + escapeHtmlWs(existing.start_date || '') + '"></label>';
    h += '<label>End date <span class="ws-part-weight-desc">(optional, blank = ongoing)</span><input type="date" class="ws-part-exempt-end" value="' + escapeHtmlWs(existing.end_date || '') + '"></label>';
    h += '<label>Reason<select class="ws-part-exempt-reason">' + reasonOpts + '</select></label>';
    h += '<label>Note <span class="ws-part-weight-desc">(optional)</span><textarea class="ws-part-exempt-note" rows="2" maxlength="500">' + escapeHtmlWs(existing.note || '') + '</textarea></label>';
    h += '<input type="hidden" class="ws-part-exempt-id" value="' + escapeHtmlWs(existing.id || '') + '">';
    h += '<button class="btn btn-primary btn-sm ws-part-exempt-save">' + (existing.id ? 'Save changes' : 'Add exemption') + '</button>';
    h += '<span class="ws-part-exempt-status"></span>';
    h += '</div>';
    return h;
  }

  function wireParticipationExemptionForm(body, existing) {
    var cred = localStorage.getItem('rw_google_credential');
    var saveBtn = body.querySelector('.ws-part-exempt-save');
    if (!saveBtn) return;
    saveBtn.addEventListener('click', function () {
      var memberSel = body.querySelector('.ws-part-exempt-member');
      var startEl = body.querySelector('.ws-part-exempt-start');
      var endEl = body.querySelector('.ws-part-exempt-end');
      var reasonEl = body.querySelector('.ws-part-exempt-reason');
      var noteEl = body.querySelector('.ws-part-exempt-note');
      var idEl = body.querySelector('.ws-part-exempt-id');
      var statusEl = body.querySelector('.ws-part-exempt-status');
      var pick = memberSel.value || '';
      var parts = pick.split('|');
      var email = parts[0] || '';
      var name = parts[1] || '';
      var payload = {
        id: idEl.value ? parseInt(idEl.value, 10) : null,
        member_email: email,
        member_name: name,
        start_date: startEl.value,
        end_date: endEl.value,
        reason: reasonEl.value,
        note: noteEl.value
      };
      if (!email || !name || !payload.start_date) {
        statusEl.className = 'ws-part-exempt-status ws-wv-err';
        statusEl.textContent = 'Member and start date are required.';
        return;
      }
      var orig = saveBtn.textContent; saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      statusEl.textContent = '';
      fetch('/api/sheets?action=participation-exemption-save', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        saveBtn.disabled = false; saveBtn.textContent = orig;
        if (!res.ok) { statusEl.className = 'ws-part-exempt-status ws-wv-err'; statusEl.textContent = (res.data && res.data.error) || 'Save failed'; return; }
        loadParticipationExemptions();
      }).catch(function (err) {
        saveBtn.disabled = false; saveBtn.textContent = orig;
        statusEl.className = 'ws-part-exempt-status ws-wv-err';
        statusEl.textContent = (err && err.message) || 'Network error';
      });
    });
  }

  // ─── CSV export ───
  function exportParticipationCSV() {
    if (!_participationReport || !_participationReport.members) {
      alert('Report still loading — try again in a moment.');
      return;
    }
    var members = _participationReport.members;
    var header = ['Member', 'Family', 'Board', 'Volunteer Roles', 'Board (count)', '1-yr Roles',
      'AM Lead', 'AM Assist', 'PM Lead', 'PM Assist', 'Cleaning',
      'Event Lead', 'Event Assist', 'Weighted Total', 'Expected', 'Coverage Given',
      'Absences', 'New', 'Exempt', 'Status'];
    var rows = [header];
    members.forEach(function (m) {
      rows.push([
        m.displayName,
        m.family,
        m.isBoard ? 'Yes' : '',
        (m.roles || []).join('; '),
        m.counts.board_role || 0,
        m.counts.one_year_role || 0,
        m.counts.am_lead || 0,
        m.counts.am_assist || 0,
        m.counts.pm_lead || 0,
        m.counts.pm_assist || 0,
        m.counts.cleaning_session || 0,
        m.counts.event_lead || 0,
        m.counts.event_assist || 0,
        m.weightedTotal || 0,
        m.expectedPoints || 0,
        m.coverageGiven || 0,
        m.absencesCount || 0,
        m.isNewMember ? 'Yes' : '',
        m.exemption ? (m.exemption.reason + (m.exemption.end_date ? ' (ends ' + m.exemption.end_date + ')' : ' (ongoing)')) : '',
        PARTICIPATION_STATUS_LABELS[m.status] || m.status
      ]);
    });
    function esc(v) {
      var s = v == null ? '' : String(v);
      if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    }
    var csv = rows.map(function (r) { return r.map(esc).join(','); }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'participation-' + (_participationReport.season || 'report') + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  }

  // ─── Print ───
  function printParticipationReport() {
    if (!_participationReport || !_participationReport.members) {
      alert('Report still loading — try again in a moment.');
      return;
    }
    openPrintIframe(buildParticipationPrintHtml(_participationReport));
  }

  function buildParticipationPrintHtml(report) {
    var members = report.members || [];
    var rows = '';
    members.forEach(function (m) {
      var c = m.counts || {};
      rows += '<tr>'
        + '<td>' + escapeHtmlWs(m.displayName) + (m.isBoard ? ' <em>[Board]</em>' : '') + (m.isNewMember ? ' <em>[New]</em>' : '') + '</td>'
        + '<td>' + (c.am_lead || 0) + '</td>'
        + '<td>' + (c.am_assist || 0) + '</td>'
        + '<td>' + (c.pm_lead || 0) + '</td>'
        + '<td>' + (c.pm_assist || 0) + '</td>'
        + '<td>' + (c.cleaning_session || 0) + '</td>'
        + '<td>' + (c.one_year_role || 0) + '</td>'
        + '<td>' + (c.event_lead || 0) + '</td>'
        + '<td>' + (c.event_assist || 0) + '</td>'
        + '<td><strong>' + (m.weightedTotal || 0) + '</strong></td>'
        + '<td>' + (m.expectedPoints || 0) + '</td>'
        + '<td>' + (m.coverageGiven || 0) + '</td>'
        + '<td>' + escapeHtmlWs(PARTICIPATION_STATUS_LABELS[m.status] || m.status) + '</td>'
        + '</tr>';
    });
    var css = 'body{font-family:Arial,sans-serif;font-size:11px;margin:24px;}'
      + 'h1{font-size:18px;margin:0 0 4px;}'
      + 'p.sub{color:#555;margin:0 0 16px;}'
      + 'table{width:100%;border-collapse:collapse;}'
      + 'th,td{border:1px solid #bbb;padding:4px 6px;text-align:left;}'
      + 'th{background:#eee;}'
      + 'td:nth-child(n+2):nth-child(-n+12){text-align:right;}';
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>Member Participation — ' + escapeHtmlWs(report.season || '') + '</title><style>' + css + '</style></head><body>';
    html += '<h1>Member Participation Tracker</h1>';
    html += '<p class="sub">Season ' + escapeHtmlWs(report.season || '') + ' · ' + members.length + ' members · printed ' + new Date().toLocaleDateString() + '</p>';
    html += '<table><thead><tr>'
      + '<th>Member</th><th>AM Ld</th><th>AM As</th><th>PM Ld</th><th>PM As</th>'
      + '<th>Clean</th><th>Roles</th><th>Evt Ld</th><th>Evt As</th>'
      + '<th>Wtd</th><th>Exp</th><th>Cov</th><th>Status</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>';
    html += '</body></html>';
    return html;
  }

  function showSendRegistrationFormModal() {
    if (!personDetail || !personDetailCard) return;
    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail rd-modal">';
    html += '<h3 class="rd-title">Send Registration Form</h3>';
    html += '<p class="rd-subtitle">Email the registration link to a prospective family. They\u2019ll fill out <code>/register.html</code> themselves.</p>';
    html += '<div class="ws-waiver-form">';
    html += '<label>Recipient name<input type="text" id="ws-ri-name" maxlength="200" placeholder="Jane Doe"></label>';
    html += '<label>Recipient email<input type="email" id="ws-ri-email" maxlength="200" placeholder="jane@example.com"></label>';
    html += '<label>Note (optional)<textarea id="ws-ri-note" maxlength="500" rows="2" placeholder="Added context that appears in the email..."></textarea></label>';
    html += '<button class="btn btn-primary btn-sm" id="ws-ri-send">Send Registration Link</button>';
    html += '<div class="ws-wv-status" id="ws-ri-status"></div>';
    html += '</div>';
    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) { if (e.target === personDetail) closeDetail(); });

    var sendBtn = personDetailCard.querySelector('#ws-ri-send');
    sendBtn.addEventListener('click', function () {
      var nameEl = personDetailCard.querySelector('#ws-ri-name');
      var emailEl = personDetailCard.querySelector('#ws-ri-email');
      var noteEl = personDetailCard.querySelector('#ws-ri-note');
      var statusEl = personDetailCard.querySelector('#ws-ri-status');
      var name = (nameEl.value || '').trim();
      var emailVal = (emailEl.value || '').trim();
      var note = (noteEl.value || '').trim();
      if (!name || !emailVal) { statusEl.className = 'ws-wv-status ws-wv-err'; statusEl.textContent = 'Name and email are required.'; return; }
      sendBtn.disabled = true; var orig = sendBtn.textContent; sendBtn.textContent = 'Sending\u2026';
      statusEl.className = 'ws-wv-status'; statusEl.textContent = '';
      var cred = localStorage.getItem('rw_google_credential');
      fetch('/api/tour', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'registration-invite', name: name, email: emailVal, note: note })
      }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        sendBtn.disabled = false; sendBtn.textContent = orig;
        if (!res.ok) {
          statusEl.className = 'ws-wv-status ws-wv-err';
          var msg = (res.data && res.data.error) || 'Send failed.';
          // Surface the auth diagnostic so a board member who's blocked
          // can see who the server thinks they are vs. who it expected.
          if (res.data && res.data.youAre) {
            msg += ' (logged in as ' + res.data.youAre + ', expected ' + res.data.expected + ')';
          }
          statusEl.textContent = msg;
          return;
        }
        statusEl.className = 'ws-wv-status ws-wv-ok';
        statusEl.textContent = res.data.emailed
          ? 'Sent. They\u2019ll get the registration link by email shortly.'
          : 'Email delivery hiccupped — copy this link to them: ' + res.data.link;
        nameEl.value = ''; emailEl.value = ''; noteEl.value = '';
      }).catch(function (err) {
        sendBtn.disabled = false; sendBtn.textContent = orig;
        statusEl.className = 'ws-wv-status ws-wv-err';
        statusEl.textContent = 'Network error: ' + ((err && err.message) || 'unknown');
      });
    });
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

  // ──────────────────────────────────────────────
  // Supply Closet Inventory
  // ──────────────────────────────────────────────
  // Loaded dynamically from /api/supply-closet?action=locations
  var SUPPLY_LOCATIONS = [];

  var SUPPLY_CATEGORIES = [
    { key: 'permanent',           label: 'Permanent',    short: 'Permanent',  sub: 'Always available' },
    { key: 'currently_available', label: 'Currently',    short: 'Currently',  sub: 'May not always be available' },
    { key: 'classroom_cabinet',   label: 'Classroom',    short: 'Classroom',  sub: 'Each AM classroom' },
    { key: 'game_closet',         label: 'Games',        short: 'Games',      sub: 'Shared with the church' }
  ];

  function supplyCategoryMeta(key) {
    for (var i = 0; i < SUPPLY_CATEGORIES.length; i++) {
      if (SUPPLY_CATEGORIES[i].key === key) return SUPPLY_CATEGORIES[i];
    }
    return null;
  }

  var supplyClosetState = {
    items: null,           // flat array of all items
    locations: null,       // array of { id, name, sort_order } from DB
    searchQuery: '',
    enabledCats: {         // which categories are visible
      permanent: true,
      currently_available: true,
      classroom_cabinet: true,
      game_closet: true
    },
    sortBy: 'name',        // 'name' | 'location' | 'category' | 'attention'
    locationFilter: '',    // '' = all locations; otherwise exact name
    editingId: null,
    addingNew: false,
    newItemCategory: 'permanent',
    canEdit: false,
    showLocations: false,  // true when location manager panel is open
    flaggingId: null,      // id currently being flagged/unflagged (UI busy state)
    qtyBusyId: null        // id currently being updated via the qty segmented control
  };

  function getSupplyCoordinatorName() {
    if (!VOLUNTEER_COMMITTEES) return null;
    for (var i = 0; i < VOLUNTEER_COMMITTEES.length; i++) {
      var roles = VOLUNTEER_COMMITTEES[i].roles || [];
      for (var j = 0; j < roles.length; j++) {
        if (roles[j].title && roles[j].title.toLowerCase().indexOf('supply coordinator') !== -1) {
          return roles[j].person || null;
        }
      }
    }
    return null;
  }

  function computeSupplyClosetCanEdit() {
    // True only for the Supply Coordinator. communications@ is the app-wide
    // super user and can always edit (including while impersonating via View As).
    var realEmail = localStorage.getItem('rw_user_email');
    if (realEmail === COMMS_EMAIL) return true;
    var email = getActiveEmail();
    if (!email) return false;
    var me = null;
    for (var i = 0; i < FAMILIES.length; i++) {
      if (familyMatchesEmail(FAMILIES[i], email)) { me = FAMILIES[i]; break; }
    }
    if (!me) return false;
    var coordName = getSupplyCoordinatorName();
    if (!coordName) return false;
    var lastName = coordName.trim().split(/\s+/).pop().toLowerCase();
    return me.name && me.name.toLowerCase() === lastName;
  }

  function fetchSupplyCloset() {
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return Promise.reject(new Error('Not authenticated'));
    return fetch('/api/supply-closet', {
      headers: { 'Authorization': 'Bearer ' + cred }
    }).then(function (r) { return r.json(); });
  }

  function fetchSupplyLocations() {
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return Promise.reject(new Error('Not authenticated'));
    return fetch('/api/supply-closet?action=locations', {
      headers: { 'Authorization': 'Bearer ' + cred }
    }).then(function (r) { return r.json(); }).then(function (data) {
      var locs = (data && data.locations) || [];
      supplyClosetState.locations = locs;
      SUPPLY_LOCATIONS = locs.map(function (l) { return l.name; });
      return locs;
    });
  }

  function escapeAttr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Escape HTML and turn any http(s) URLs into clickable anchors.
  function linkify(s) {
    var escaped = escapeAttr(s);
    return escaped.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    });
  }

  // Capitalize the first letter and leave the rest as the user typed it.
  // Acronyms like "PVA" or "X-Acto" are preserved.
  function capitalizeFirstLetter(s) {
    var v = String(s || '').replace(/^\s+/, '');
    if (!v) return v;
    return v.charAt(0).toUpperCase() + v.slice(1);
  }

  function filterAndSortSupplyItems() {
    var state = supplyClosetState;
    if (!state.items) return [];
    var q = state.searchQuery.trim().toLowerCase();
    var locFilter = (state.locationFilter || '').toLowerCase();
    var rows = state.items.filter(function (item) {
      if (!state.enabledCats[item.category]) return false;
      if (locFilter && (item.location || '').toLowerCase() !== locFilter) return false;
      if (!q) return true;
      return (
        (item.item_name || '').toLowerCase().indexOf(q) !== -1 ||
        (item.location || '').toLowerCase().indexOf(q) !== -1 ||
        (item.notes || '').toLowerCase().indexOf(q) !== -1
      );
    });
    var sortBy = state.sortBy;
    // Flagged items ALWAYS float to the top, regardless of the selected sort.
    // Within each group (flagged / unflagged) the user's sort choice applies.
    rows.sort(function (a, b) {
      var fa = a.needs_restock ? 0 : 1;
      var fb = b.needs_restock ? 0 : 1;
      if (fa !== fb) return fa - fb;
      if (sortBy === 'location') {
        var la = (a.location || '\uffff').toLowerCase();
        var lb = (b.location || '\uffff').toLowerCase();
        if (la !== lb) return la < lb ? -1 : 1;
      } else if (sortBy === 'category') {
        if (a.category !== b.category) return a.category < b.category ? -1 : 1;
      }
      var na = (a.item_name || '').toLowerCase();
      var nb = (b.item_name || '').toLowerCase();
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
    return rows;
  }

  function renderSupplyClosetModal() {
    if (!personDetail || !personDetailCard) return;
    var state = supplyClosetState;
    var rows = filterAndSortSupplyItems();

    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail sc-modal' + (state.browseMode ? ' sc-browse' : '') + '">';
    html += '<h3>Supply Closet Inventory</h3>';
    html += '<p class="sc-intro">Search what\'s available in the co-op\'s closets and cabinets. If something is running low, tap <strong>Report low</strong> next to the item and the Supply Coordinator will be notified.</p>';

    // Controls: search + location + sort (single calm row)
    html += '<div class="sc-controls">';
    html += '<input type="text" class="sc-search" id="sc-search-input" placeholder="Search items, locations, notes..." value="' + escapeAttr(state.searchQuery) + '">';
    html += '<select class="sc-loc-select" id="sc-loc-select" aria-label="Filter by location">';
    html += '<option value=""' + (state.locationFilter ? '' : ' selected') + '>All locations</option>';
    SUPPLY_LOCATIONS.forEach(function (loc) {
      var sel = state.locationFilter === loc ? ' selected' : '';
      html += '<option value="' + escapeAttr(loc) + '"' + sel + '>' + escapeAttr(loc) + '</option>';
    });
    html += '</select>';
    html += '<select class="sc-sort" id="sc-sort-select" aria-label="Sort order">';
    var sortOptions = [
      { v: 'name', label: 'Sort: Name' },
      { v: 'location', label: 'Sort: Location' },
      { v: 'category', label: 'Sort: Category' }
    ];
    sortOptions.forEach(function (o) {
      var sel = state.sortBy === o.v ? ' selected' : '';
      html += '<option value="' + o.v + '"' + sel + '>' + o.label + '</option>';
    });
    html += '</select>';
    if (state.canEdit) {
      html += '<button class="sc-btn sc-manage-locs-btn" id="sc-manage-locs-btn" title="Manage locations">Manage locations</button>';
    }
    html += '</div>';

    // Category filter: calm outlined pills with colored dot (keeps brand colors meaningful but quieter)
    html += '<div class="sc-cat-filters" role="group" aria-label="Filter by category">';
    SUPPLY_CATEGORIES.forEach(function (cat) {
      var on = state.enabledCats[cat.key];
      var classes = 'sc-cat-chip sc-cat-' + cat.key + (on ? ' sc-on' : ' sc-off');
      html += '<button class="' + classes + '" data-cat="' + cat.key + '" aria-pressed="' + (on ? 'true' : 'false') + '">';
      html += '<span class="sc-cat-dot" aria-hidden="true"></span>';
      html += '<span class="sc-cat-label">' + cat.short + '</span>';
      html += '</button>';
    });
    html += '</div>';

    // Count
    var totalCount = state.items ? state.items.length : 0;
    html += '<div class="sc-count">Showing ' + rows.length + ' of ' + totalCount + ' items</div>';

    // Item list
    html += '<div class="sc-list">' + renderSupplyListBody(rows, state) + '</div>';

    // Footer
    html += '<div class="sc-footer">';
    if (state.canEdit) {
      html += '<button id="sc-add-btn" class="sc-add">+ Add Item</button>';
    } else {
      html += '<span></span>';
    }
    var coord = getSupplyCoordinatorName();
    if (coord) {
      html += '<span class="sc-coord">Supply Coordinator: <strong>' + escapeAttr(coord) + '</strong></span>';
    }
    html += '</div>';

    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    wireSupplyClosetEvents();
  }

  // Renders just the <div class="sc-list"> INNER HTML. Splits the result into
  // a "Needs restocking" section at the top and an "All items" section below
  // whenever any flagged items are present. Shared by full and list-only
  // refreshes so both paths use identical markup.
  function renderSupplyListBody(rows, state) {
    var html = '';
    if (state.addingNew) html += renderEditRow(null);
    if (rows.length === 0 && !state.addingNew) {
      var msg = state.searchQuery ? 'No items match your search.' : 'No items in the selected categories.';
      html += '<div class="sc-empty">' + msg + '</div>';
      return html;
    }
    var flagged = [];
    var rest = [];
    rows.forEach(function (item) {
      if (item.needs_restock) flagged.push(item); else rest.push(item);
    });
    function renderGroup(group) {
      return group.map(function (item) {
        return state.editingId === item.id ? renderEditRow(item) : renderReadRow(item);
      }).join('');
    }
    if (flagged.length > 0) {
      html += '<div class="sc-section-header sc-section-flagged">Needs restocking (' + flagged.length + ')</div>';
      html += renderGroup(flagged);
      if (rest.length > 0) {
        html += '<div class="sc-section-header sc-section-rest">All items</div>';
      }
    }
    html += renderGroup(rest);
    return html;
  }

  function renderReadRow(item) {
    var canEdit = supplyClosetState.canEdit;
    var cat = supplyCategoryMeta(item.category);
    var badgeLabel = cat ? cat.short : item.category;
    var flagged = !!item.needs_restock;
    var busy = supplyClosetState.flaggingId === item.id;

    var rowClass = 'sc-row' + (flagged ? ' sc-flagged' : '');
    var html = '<div class="' + rowClass + '">';
    html += '<div>';
    html += '<div class="sc-name">' + escapeAttr(item.item_name);
    if (flagged) {
      var who = item.restock_flagged_by ? ' by ' + escapeAttr(item.restock_flagged_by) : '';
      html += ' <span class="sc-flag-indicator" title="Flagged' + who + '">Needs restock</span>';
    }
    html += '</div>';
    if (item.location) html += '<div class="sc-loc">' + escapeAttr(item.location) + '</div>';
    if (item.notes) html += '<div class="sc-notes">' + linkify(item.notes) + '</div>';
    html += '</div>';
    html += '<span class="sc-badge sc-badge-' + item.category + '">' + escapeAttr(badgeLabel) + '</span>';
    html += '<div class="sc-actions">';
    // Coordinator quantity segmented control (sets quantity_level on click).
    // Shown only to the coordinator; informational, independent of the flag.
    if (canEdit) {
      var level = item.quantity_level || '';
      var qtyBusy = supplyClosetState.qtyBusyId === item.id;
      html += '<div class="sc-qty-seg" role="radiogroup" aria-label="Quantity"' + (qtyBusy ? ' data-busy="1"' : '') + '>';
      ['empty', 'low', 'medium', 'high'].forEach(function (opt) {
        var active = level === opt;
        html += '<button class="sc-qty-opt sc-qty-' + opt + (active ? ' sc-qty-active' : '') + '"'
          + ' data-id="' + item.id + '" data-level="' + opt + '"'
          + (qtyBusy ? ' disabled' : '')
          + ' aria-pressed="' + (active ? 'true' : 'false') + '"'
          + ' title="' + opt.charAt(0).toUpperCase() + opt.slice(1) + '">'
          + opt.charAt(0).toUpperCase() + opt.slice(1)
          + '</button>';
      });
      html += '</div>';
    }
    // Flag (any member) / unflag (coord only)
    if (!flagged) {
      html += '<button class="sc-btn sc-flag-btn" data-id="' + item.id + '"' + (busy ? ' disabled' : '') + '>'
        + (busy ? 'Reporting…' : 'Report low') + '</button>';
    } else if (canEdit) {
      html += '<button class="sc-btn sc-unflag-btn" data-id="' + item.id + '"' + (busy ? ' disabled' : '') + '>'
        + (busy ? 'Clearing…' : 'Mark restocked') + '</button>';
    }
    if (canEdit) {
      html += '<button class="sc-btn sc-edit-btn" data-id="' + item.id + '">Edit</button>';
      html += '<button class="sc-btn sc-btn-del sc-del-btn" data-id="' + item.id + '">Delete</button>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderEditRow(item) {
    var isNew = !item;
    var name = isNew ? '' : escapeAttr(item.item_name);
    var loc = isNew ? '' : escapeAttr(item.location);
    var notes = isNew ? '' : escapeAttr(item.notes);
    var currentCat = isNew ? supplyClosetState.newItemCategory : item.category;
    var idAttr = isNew ? 'new' : item.id;

    var html = '<div class="sc-edit-form">';
    html += '<div class="sc-edit-grid">';
    html += '<input class="sc-in-name" data-id="' + idAttr + '" placeholder="Item name" value="' + name + '">';
    html += '<select class="sc-in-loc" data-id="' + idAttr + '">';
    html += '<option value=""' + (!loc ? ' selected' : '') + '>Location…</option>';
    SUPPLY_LOCATIONS.forEach(function (l) {
      html += '<option value="' + escapeAttr(l) + '"' + (loc === escapeAttr(l) ? ' selected' : '') + '>' + escapeAttr(l) + '</option>';
    });
    html += '</select>';
    html += '<select class="sc-in-cat" data-id="' + idAttr + '">';
    SUPPLY_CATEGORIES.forEach(function (c) {
      var sel = c.key === currentCat ? ' selected' : '';
      html += '<option value="' + c.key + '"' + sel + '>' + c.label + '</option>';
    });
    html += '</select>';
    html += '</div>';
    html += '<input class="sc-in-notes sc-edit-notes" data-id="' + idAttr + '" placeholder="Notes (optional)" value="' + notes + '">';
    html += '<div class="sc-edit-actions">';
    html += '<button class="sc-btn sc-cancel-btn" data-id="' + idAttr + '">Cancel</button>';
    html += '<button class="sc-save sc-save-btn" data-id="' + idAttr + '">Save</button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderLocationManager() {
    if (!personDetail || !personDetailCard) return;
    var locs = supplyClosetState.locations || [];

    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail sc-modal">';
    html += '<h3>Manage Storage Locations</h3>';
    html += '<p class="sc-intro">Add, rename, or remove the locations that appear in the supply closet location dropdown.</p>';

    html += '<div class="sc-locs-list">';
    if (locs.length === 0) {
      html += '<div class="sc-empty">No locations yet. Add one below.</div>';
    }
    locs.forEach(function (loc) {
      html += '<div class="sc-loc-row" data-loc-id="' + loc.id + '">';
      html += '<input class="cl-input sc-loc-name-input" value="' + escapeAttr(loc.name) + '" data-loc-id="' + loc.id + '">';
      html += '<button class="sc-btn sc-loc-rename" data-loc-id="' + loc.id + '" title="Save name">Rename</button>';
      html += '<button class="sc-btn sc-loc-delete" data-loc-id="' + loc.id + '" title="Delete location">&times;</button>';
      html += '</div>';
    });
    html += '</div>';

    html += '<div class="sc-loc-add-row">';
    html += '<input class="cl-input sc-loc-new-input" placeholder="New location name…" id="sc-loc-new-input">';
    html += '<button class="sc-btn sc-save" id="sc-loc-add-btn">Add</button>';
    html += '</div>';

    html += '<div class="sc-footer" style="margin-top:1rem;">';
    html += '<button class="sc-add" id="sc-locs-back-btn">&larr; Back to Inventory</button>';
    html += '</div>';
    html += '</div>';

    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    wireLocationManagerEvents();
  }

  function wireLocationManagerEvents() {
    var cred = localStorage.getItem('rw_google_credential');
    var headers = { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' };

    // Close
    var closeBtn = personDetailCard.querySelector('.detail-close');
    if (closeBtn) closeBtn.addEventListener('click', closeDetail);
    personDetail.onclick = function (e) {
      if (e.target === personDetail) closeDetail();
    };

    // Back
    var backBtn = personDetailCard.querySelector('#sc-locs-back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        // Refresh locations then go back to inventory
        fetchSupplyLocations().catch(function () {}).then(function () {
          loadSupplyClosetAndRender();
        });
      });
    }

    // Add location
    var addBtn = personDetailCard.querySelector('#sc-loc-add-btn');
    var addInput = personDetailCard.querySelector('#sc-loc-new-input');
    if (addBtn && addInput) {
      addBtn.addEventListener('click', function () {
        var name = addInput.value.trim();
        if (!name) return;
        addBtn.disabled = true;
        addBtn.textContent = 'Adding…';
        fetch('/api/supply-closet?action=locations', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ name: name })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.error) { alert('Error: ' + data.error); addBtn.disabled = false; addBtn.textContent = 'Add'; return; }
          return fetchSupplyLocations().then(function () { renderLocationManager(); });
        }).catch(function (err) { alert('Network error: ' + err.message); addBtn.disabled = false; addBtn.textContent = 'Add'; });
      });
      // Allow Enter key in the input
      addInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
      });
    }

    // Rename buttons
    personDetailCard.querySelectorAll('.sc-loc-rename').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-loc-id');
        var input = personDetailCard.querySelector('.sc-loc-name-input[data-loc-id="' + id + '"]');
        var name = input ? input.value.trim() : '';
        if (!name) { alert('Name cannot be empty.'); return; }
        btn.disabled = true;
        btn.textContent = 'Saving…';
        fetch('/api/supply-closet?action=locations&id=' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: headers,
          body: JSON.stringify({ name: name })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.error) { alert('Error: ' + data.error); btn.disabled = false; btn.textContent = 'Rename'; return; }
          return fetchSupplyLocations().then(function () { renderLocationManager(); });
        }).catch(function (err) { alert('Network error: ' + err.message); btn.disabled = false; btn.textContent = 'Rename'; });
      });
    });

    // Delete buttons
    personDetailCard.querySelectorAll('.sc-loc-delete').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-loc-id');
        var row = btn.closest('.sc-loc-row');
        var input = row ? row.querySelector('.sc-loc-name-input') : null;
        var locName = input ? input.value : 'this location';

        // Count items currently stored at this location so we can ask the
        // user where they should be moved before the location is deleted.
        var items = supplyClosetState.items || [];
        var affected = items.filter(function (it) {
          return (it.location || '').toLowerCase() === (locName || '').toLowerCase();
        });

        if (affected.length === 0) {
          if (!confirm('Delete "' + locName + '"? No items are using this location.')) return;
          doDeleteLocation(id, '', btn);
          return;
        }

        // Replace the row with a Move & Delete form.
        var otherLocs = (supplyClosetState.locations || []).filter(function (l) {
          return String(l.id) !== String(id);
        });
        var html = '';
        html += '<div class="sc-loc-delete-prompt" style="display:flex;flex-direction:column;gap:0.5rem;width:100%;padding:0.75rem;background:var(--bg-soft,#faf7f2);border-radius:6px;">';
        html += '<div><strong>' + affected.length + '</strong> item' + (affected.length === 1 ? '' : 's') + ' at <strong>' + escapeAttr(locName) + '</strong>.</div>';
        html += '<label style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">';
        html += '<span>Move to:</span>';
        html += '<select class="cl-input sc-loc-move-select">';
        html += '<option value="">(no location)</option>';
        otherLocs.forEach(function (l) {
          html += '<option value="' + escapeAttr(l.name) + '">' + escapeAttr(l.name) + '</option>';
        });
        html += '</select>';
        html += '</label>';
        html += '<div style="display:flex;gap:0.5rem;justify-content:flex-end;">';
        html += '<button class="sc-btn sc-loc-cancel-delete">Cancel</button>';
        html += '<button class="sc-btn sc-save sc-loc-confirm-delete" data-loc-id="' + id + '">Move &amp; Delete</button>';
        html += '</div>';
        html += '</div>';
        row.innerHTML = html;

        var cancelBtn = row.querySelector('.sc-loc-cancel-delete');
        var confirmBtn = row.querySelector('.sc-loc-confirm-delete');
        var select = row.querySelector('.sc-loc-move-select');
        if (cancelBtn) cancelBtn.addEventListener('click', function () { renderLocationManager(); });
        if (confirmBtn) {
          confirmBtn.addEventListener('click', function () {
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Moving…';
            doDeleteLocation(id, select ? select.value : '', confirmBtn);
          });
        }
      });
    });
  }

  function doDeleteLocation(id, moveTo, btn) {
    var cred = localStorage.getItem('rw_google_credential');
    var headers = { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' };
    var url = '/api/supply-closet?action=locations&id=' + encodeURIComponent(id);
    if (moveTo) url += '&moveTo=' + encodeURIComponent(moveTo);
    fetch(url, { method: 'DELETE', headers: headers })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('Error: ' + data.error); if (btn) btn.disabled = false; return; }
        // Refresh both locations and inventory so list + items stay in sync.
        return Promise.all([
          fetchSupplyLocations(),
          fetchSupplyCloset().then(function (invData) {
            if (invData && invData.items) {
              var flat = [];
              SUPPLY_CATEGORIES.forEach(function (cat) {
                (invData.items[cat.key] || []).forEach(function (r) { flat.push(r); });
              });
              supplyClosetState.items = flat;
            }
          })
        ]).then(function () { renderLocationManager(); });
      })
      .catch(function (err) { alert('Network error: ' + err.message); if (btn) btn.disabled = false; });
  }

  function wireSupplyClosetEvents() {
    // Close button + backdrop
    var closeBtn = personDetailCard.querySelector('.detail-close');
    if (closeBtn) closeBtn.addEventListener('click', closeDetail);
    personDetail.onclick = function (e) {
      if (e.target === personDetail) closeDetail();
    };

    // Search input — update list in place so the input keeps focus
    var searchInput = personDetailCard.querySelector('#sc-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        supplyClosetState.searchQuery = searchInput.value;
        updateSupplyClosetListOnly();
      });
    }

    // Sort dropdown
    var sortSelect = personDetailCard.querySelector('#sc-sort-select');
    if (sortSelect) {
      sortSelect.addEventListener('change', function () {
        supplyClosetState.sortBy = sortSelect.value;
        renderSupplyClosetModal();
      });
    }

    // Location filter (native select)
    var locSelect = personDetailCard.querySelector('#sc-loc-select');
    if (locSelect) {
      locSelect.addEventListener('change', function () {
        supplyClosetState.locationFilter = locSelect.value || '';
        renderSupplyClosetModal();
      });
    }

    // Category filter chips (toggle)
    personDetailCard.querySelectorAll('.sc-cat-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var key = chip.getAttribute('data-cat');
        supplyClosetState.enabledCats[key] = !supplyClosetState.enabledCats[key];
        // Don't allow all off — re-enable if user toggled the last one
        var anyOn = false;
        Object.keys(supplyClosetState.enabledCats).forEach(function (k) {
          if (supplyClosetState.enabledCats[k]) anyOn = true;
        });
        if (!anyOn) supplyClosetState.enabledCats[key] = true;
        renderSupplyClosetModal();
      });
    });

    // Add button
    var addBtn = personDetailCard.querySelector('#sc-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        supplyClosetState.addingNew = true;
        supplyClosetState.editingId = null;
        renderSupplyClosetModal();
      });
    }

    // Manage Locations button
    var manageLocsBtn = personDetailCard.querySelector('#sc-manage-locs-btn');
    if (manageLocsBtn) {
      manageLocsBtn.addEventListener('click', function () {
        renderLocationManager();
      });
    }

    // Edit
    personDetailCard.querySelectorAll('.sc-edit-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        supplyClosetState.editingId = parseInt(btn.getAttribute('data-id'), 10);
        supplyClosetState.addingNew = false;
        renderSupplyClosetModal();
      });
    });

    // Cancel
    personDetailCard.querySelectorAll('.sc-cancel-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        supplyClosetState.editingId = null;
        supplyClosetState.addingNew = false;
        renderSupplyClosetModal();
      });
    });

    // Save
    personDetailCard.querySelectorAll('.sc-save-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idAttr = btn.getAttribute('data-id');
        var nameEl = personDetailCard.querySelector('.sc-in-name[data-id="' + idAttr + '"]');
        var locEl = personDetailCard.querySelector('.sc-in-loc[data-id="' + idAttr + '"]');
        var notesEl = personDetailCard.querySelector('.sc-in-notes[data-id="' + idAttr + '"]');
        var catEl = personDetailCard.querySelector('.sc-in-cat[data-id="' + idAttr + '"]');
        var payload = {
          item_name: nameEl ? nameEl.value : '',
          location: locEl ? locEl.value : '',
          notes: notesEl ? notesEl.value : '',
          category: catEl ? catEl.value : 'permanent'
        };
        if (!payload.item_name.trim()) { alert('Item name is required.'); return; }
        btn.disabled = true;
        btn.textContent = 'Saving...';

        var cred = localStorage.getItem('rw_google_credential');
        var url = '/api/supply-closet';
        var method = 'POST';
        if (idAttr !== 'new') {
          url += '?id=' + encodeURIComponent(idAttr);
          method = 'PATCH';
        }
        fetch(url, {
          method: method,
          headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
          .then(function (res) {
            if (!res.ok) { alert('Error: ' + (res.data.error || 'save failed')); btn.disabled = false; btn.textContent = 'Save'; return; }
            supplyClosetState.editingId = null;
            supplyClosetState.addingNew = false;
            loadSupplyClosetAndRender();
          })
          .catch(function (err) { alert('Network error: ' + err.message); btn.disabled = false; btn.textContent = 'Save'; });
      });
    });

    // Delete
    personDetailCard.querySelectorAll('.sc-del-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('Delete this item from the inventory?')) return;
        var id = btn.getAttribute('data-id');
        var cred = localStorage.getItem('rw_google_credential');
        fetch('/api/supply-closet?id=' + encodeURIComponent(id), {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + cred }
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
          .then(function (res) {
            if (!res.ok) { alert('Error: ' + (res.data.error || 'delete failed')); return; }
            loadSupplyClosetAndRender();
          })
          .catch(function (err) { alert('Network error: ' + err.message); });
      });
    });

    // Flag + unflag
    personDetailCard.querySelectorAll('.sc-flag-btn').forEach(function (btn) {
      btn.addEventListener('click', handleSupplyClosetFlag);
    });
    personDetailCard.querySelectorAll('.sc-unflag-btn').forEach(function (btn) {
      btn.addEventListener('click', handleSupplyClosetUnflag);
    });
    // Quantity segmented control (coordinator only)
    personDetailCard.querySelectorAll('.sc-qty-opt').forEach(function (btn) {
      btn.addEventListener('click', handleSupplyClosetQuantity);
    });
  }

  function handleSupplyClosetQuantity() {
    var id = parseInt(this.getAttribute('data-id'), 10);
    var level = this.getAttribute('data-level');
    if (!id || !level) return;
    // Clicking the currently-active option clears it (toggle off).
    var current = (supplyClosetState.items || []).find(function (it) { return it.id === id; });
    var nextLevel = current && current.quantity_level === level ? null : level;
    supplyClosetState.qtyBusyId = id;
    var cred = localStorage.getItem('rw_google_credential');
    updateSupplyClosetListOnly();
    fetch('/api/supply-closet?id=' + encodeURIComponent(id) + '&action=quantity', {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity_level: nextLevel })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        supplyClosetState.qtyBusyId = null;
        if (!res.ok) {
          alert('Could not update quantity: ' + (res.data.error || 'error'));
          updateSupplyClosetListOnly();
          return;
        }
        // Patch local item in place so we don't reload the whole list.
        var updated = res.data.item;
        if (updated) {
          var list = supplyClosetState.items || [];
          for (var i = 0; i < list.length; i++) {
            if (list[i].id === updated.id) { list[i] = updated; break; }
          }
        }
        updateSupplyClosetListOnly();
      })
      .catch(function (err) {
        supplyClosetState.qtyBusyId = null;
        alert('Network error: ' + err.message);
        updateSupplyClosetListOnly();
      });
  }

  function handleSupplyClosetFlag() {
    var id = parseInt(this.getAttribute('data-id'), 10);
    if (!id) return;
    supplyClosetState.flaggingId = id;
    var cred = localStorage.getItem('rw_google_credential');
    // Optimistically re-render busy state
    renderSupplyClosetModal();
    fetch('/api/supply-closet?id=' + encodeURIComponent(id) + '&action=flag', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' }
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        supplyClosetState.flaggingId = null;
        if (!res.ok) {
          alert('Could not flag item: ' + (res.data.error || 'error'));
          renderSupplyClosetModal();
          return;
        }
        loadSupplyClosetAndRender();
        if (!res.data.already_flagged) showSupplyToast('Supply Coordinator notified — thanks!');
      })
      .catch(function (err) {
        supplyClosetState.flaggingId = null;
        alert('Network error: ' + err.message);
        renderSupplyClosetModal();
      });
  }

  function handleSupplyClosetUnflag() {
    var id = parseInt(this.getAttribute('data-id'), 10);
    if (!id) return;
    supplyClosetState.flaggingId = id;
    var cred = localStorage.getItem('rw_google_credential');
    renderSupplyClosetModal();
    fetch('/api/supply-closet?id=' + encodeURIComponent(id) + '&action=unflag', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' }
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        supplyClosetState.flaggingId = null;
        if (!res.ok) {
          alert('Could not clear flag: ' + (res.data.error || 'error'));
          renderSupplyClosetModal();
          return;
        }
        loadSupplyClosetAndRender();
      })
      .catch(function (err) {
        supplyClosetState.flaggingId = null;
        alert('Network error: ' + err.message);
        renderSupplyClosetModal();
      });
  }

  function showSupplyToast(msg) {
    var t = document.createElement('div');
    t.className = 'sc-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('sc-toast-show'); }, 10);
    setTimeout(function () {
      t.classList.remove('sc-toast-show');
      setTimeout(function () { t.parentNode && t.parentNode.removeChild(t); }, 300);
    }, 2400);
  }

  function updateSupplyClosetListOnly() {
    // Re-render only the list + count when search changes, so the search
    // input keeps focus and cursor position.
    var state = supplyClosetState;
    var rows = filterAndSortSupplyItems();
    var totalCount = state.items ? state.items.length : 0;

    var countEl = personDetailCard.querySelector('.sc-count');
    if (countEl) countEl.textContent = 'Showing ' + rows.length + ' of ' + totalCount + ' items';

    var listEl = personDetailCard.querySelector('.sc-list');
    if (!listEl) return;

    listEl.innerHTML = renderSupplyListBody(rows, state);

    // Re-wire only the events inside the list (edit/delete/save/cancel)
    wireSupplyClosetListEvents();
  }

  function wireSupplyClosetListEvents() {
    // Edit
    personDetailCard.querySelectorAll('.sc-list .sc-edit-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        supplyClosetState.editingId = parseInt(btn.getAttribute('data-id'), 10);
        supplyClosetState.addingNew = false;
        renderSupplyClosetModal();
      });
    });
    // Cancel
    personDetailCard.querySelectorAll('.sc-list .sc-cancel-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        supplyClosetState.editingId = null;
        supplyClosetState.addingNew = false;
        renderSupplyClosetModal();
      });
    });
    // Save
    personDetailCard.querySelectorAll('.sc-list .sc-save-btn').forEach(function (btn) {
      btn.addEventListener('click', handleSupplyClosetSave);
    });
    // Delete
    personDetailCard.querySelectorAll('.sc-list .sc-del-btn').forEach(function (btn) {
      btn.addEventListener('click', handleSupplyClosetDelete);
    });
    // Flag + unflag
    personDetailCard.querySelectorAll('.sc-list .sc-flag-btn').forEach(function (btn) {
      btn.addEventListener('click', handleSupplyClosetFlag);
    });
    personDetailCard.querySelectorAll('.sc-list .sc-unflag-btn').forEach(function (btn) {
      btn.addEventListener('click', handleSupplyClosetUnflag);
    });
    personDetailCard.querySelectorAll('.sc-list .sc-qty-opt').forEach(function (btn) {
      btn.addEventListener('click', handleSupplyClosetQuantity);
    });
  }

  function handleSupplyClosetSave() {
    var btn = this;
    var idAttr = btn.getAttribute('data-id');
    var nameEl = personDetailCard.querySelector('.sc-in-name[data-id="' + idAttr + '"]');
    var locEl = personDetailCard.querySelector('.sc-in-loc[data-id="' + idAttr + '"]');
    var notesEl = personDetailCard.querySelector('.sc-in-notes[data-id="' + idAttr + '"]');
    var catEl = personDetailCard.querySelector('.sc-in-cat[data-id="' + idAttr + '"]');
    var payload = {
      item_name: nameEl ? nameEl.value : '',
      location: locEl ? locEl.value : '',
      notes: notesEl ? notesEl.value : '',
      category: catEl ? catEl.value : 'permanent'
    };
    if (!payload.item_name.trim()) { alert('Item name is required.'); return; }
    btn.disabled = true;
    btn.textContent = 'Saving...';

    var cred = localStorage.getItem('rw_google_credential');
    var url = '/api/supply-closet';
    var method = 'POST';
    if (idAttr !== 'new') {
      url += '?id=' + encodeURIComponent(idAttr);
      method = 'PATCH';
    }
    fetch(url, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) { alert('Error: ' + (res.data.error || 'save failed')); btn.disabled = false; btn.textContent = 'Save'; return; }
        supplyClosetState.editingId = null;
        supplyClosetState.addingNew = false;
        loadSupplyClosetAndRender();
      })
      .catch(function (err) { alert('Network error: ' + err.message); btn.disabled = false; btn.textContent = 'Save'; });
  }

  function handleSupplyClosetDelete() {
    if (!confirm('Delete this item from the inventory?')) return;
    var id = this.getAttribute('data-id');
    var cred = localStorage.getItem('rw_google_credential');
    fetch('/api/supply-closet?id=' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + cred }
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) { alert('Error: ' + (res.data.error || 'delete failed')); return; }
        loadSupplyClosetAndRender();
      })
      .catch(function (err) { alert('Network error: ' + err.message); });
  }

  function loadSupplyClosetAndRender() {
    fetchSupplyCloset().then(function (data) {
      if (data.error) { alert('Error loading supply closet: ' + data.error); return; }
      // Flatten the grouped API response into a single array
      var flat = [];
      SUPPLY_CATEGORIES.forEach(function (cat) {
        var rows = (data.items && data.items[cat.key]) || [];
        rows.forEach(function (r) { flat.push(r); });
      });
      supplyClosetState.items = flat;
      renderSupplyClosetModal();
    }).catch(function (err) {
      alert('Could not load supply closet: ' + err.message);
    });
  }

  function showSupplyClosetPopup(browseOnly) {
    supplyClosetState.canEdit = browseOnly ? false : computeSupplyClosetCanEdit();
    supplyClosetState.browseMode = !!browseOnly;
    supplyClosetState.searchQuery = '';
    supplyClosetState.sortBy = 'name';
    supplyClosetState.enabledCats = {
      permanent: true,
      currently_available: true,
      classroom_cabinet: true,
      game_closet: true
    };
    supplyClosetState.editingId = null;
    supplyClosetState.addingNew = false;
    supplyClosetState.newItemCategory = 'permanent';
    supplyClosetState.showLocations = false;
    supplyClosetState.locationFilter = '';
    supplyClosetState.flaggingId = null;
    supplyClosetState.qtyBusyId = null;
    // Load locations (if not yet loaded) alongside the items
    var locsPromise = supplyClosetState.locations ? Promise.resolve() : fetchSupplyLocations().catch(function () { SUPPLY_LOCATIONS = []; });
    locsPromise.then(function () { loadSupplyClosetAndRender(); });
  }

  var supplyClosetBtn = document.getElementById('supplyClosetBtn');
  if (supplyClosetBtn) {
    supplyClosetBtn.addEventListener('click', function () { showSupplyClosetPopup(true); });
  }

  // ──────────────────────────────────────────────
  // Curriculum Library
  // ──────────────────────────────────────────────
  var SUBJECT_OPTIONS = [
    'Art',
    'Music',
    'Drama / Performing Arts',
    'Science',
    'Math',
    'Reading / Literature',
    'Writing',
    'History / Social Studies',
    'Geography',
    'Nature / Outdoor',
    'Cooking',
    'Crafts',
    'Movement / PE',
    'Languages',
    'Life Skills',
    'Other'
  ];

  // Mirrors the co-op's age groups, plus broader buckets and "All ages".
  var AGE_RANGE_OPTIONS = [
    'Saplings (3-5)',
    'Sassafras (5-6)',
    'Oaks (7-8)',
    'Maples (8-9)',
    'Birch (9-10)',
    'Willows (10-11)',
    'Cedars (12-13)',
    'Pigeons (14+)',
    'Mixed: Younger (3-8)',
    'Mixed: Elementary (5-11)',
    'Mixed: Older (8-14)',
    'All ages'
  ];

  var curriculumState = {
    view: 'library',      // 'library' | 'detail' | 'editor'
    list: null,           // array of curriculum summaries
    current: null,        // full curriculum object when in detail view
    draft: null,          // in-progress edit (separate from current so we can cancel)
    editingId: null,      // id being edited, or null for new
    searchQuery: '',
    subjectFilter: '',
    ageFilter: '',
    closetItems: null     // cached supply_closet for the autocomplete datalist
  };

  function loadClosetItemsForEditor() {
    if (curriculumState.closetItems) return Promise.resolve();
    var cred = localStorage.getItem('rw_google_credential');
    return fetch('/api/supply-closet', {
      headers: { 'Authorization': 'Bearer ' + cred }
    }).then(function (r) { return r.json(); }).then(function (data) {
      // Flatten grouped response into one array
      var flat = [];
      if (data && data.items) {
        Object.keys(data.items).forEach(function (cat) {
          (data.items[cat] || []).forEach(function (item) {
            flat.push({ id: item.id, item_name: item.item_name, location: item.location, category: cat });
          });
        });
      }
      // De-dupe by name (some items appear in multiple categories)
      var seen = {};
      curriculumState.closetItems = flat.filter(function (i) {
        var k = i.item_name.toLowerCase();
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      }).sort(function (a, b) { return a.item_name.localeCompare(b.item_name); });
    }).catch(function () {
      curriculumState.closetItems = []; // fail open with empty list
    });
  }

  function CATEGORY_LABEL(cat) {
    if (cat === 'permanent') return 'Permanent';
    if (cat === 'currently_available') return 'Currently available';
    if (cat === 'classroom_cabinet') return 'Classroom';
    if (cat === 'game_closet') return 'Games';
    return cat;
  }

  function blankLesson(num) {
    return {
      lesson_number: num,
      title: '',
      overview: '',
      room_setup: '',
      activity: [''],
      instruction: [''],
      links: [],
      supplies: []
    };
  }

  // Pad activity & instruction arrays to the same length so they can be
  // edited as parallel numbered rows.
  function padPair(a, b) {
    var max = Math.max(a.length, b.length, 1);
    while (a.length < max) a.push('');
    while (b.length < max) b.push('');
  }

  function blankDraft() {
    var lessons = [];
    for (var i = 1; i <= 5; i++) lessons.push(blankLesson(i));
    return {
      title: '',
      subject: '',
      age_range: '',
      block: '',
      overview: '',
      tags: [],
      edit_policy: 'author_only',
      lesson_count: 5,
      lessons: lessons
    };
  }

  function draftFromCurriculum(curr) {
    // Deep-clone so edits don't mutate curriculumState.current.
    var draft = {
      title: curr.title || '',
      subject: curr.subject || '',
      age_range: curr.age_range || '',
      block: curr.block || '',
      overview: curr.overview || '',
      tags: (curr.tags || []).slice(),
      edit_policy: curr.edit_policy || 'author_only',
      lesson_count: curr.lesson_count || 5,
      lessons: []
    };
    // Ensure we have exactly 5 lesson slots (so toggling lesson_count up works)
    for (var i = 1; i <= 5; i++) {
      var src = (curr.lessons || []).find(function (l) { return l.lesson_number === i; });
      if (src) {
        var act = (src.activity && src.activity.length ? src.activity.slice() : ['']);
        var ins = (src.instruction && src.instruction.length ? src.instruction.slice() : ['']);
        padPair(act, ins);
        draft.lessons.push({
          lesson_number: i,
          title: src.title || '',
          overview: src.overview || '',
          room_setup: src.room_setup || '',
          activity: act,
          instruction: ins,
          links: (src.links || []).map(function (l) { return { label: l.label || '', url: l.url || '' }; }),
          supplies: (src.supplies || []).map(function (s) { return { item_name: s.item_name || '', qty: s.qty || '', qty_unit: s.qty_unit || '', notes: s.notes || '', closet_item_id: s.closet_item_id || null }; })
        });
      } else {
        draft.lessons.push(blankLesson(i));
      }
    }
    return draft;
  }

  function currentUserIsBoard() {
    var email = localStorage.getItem('rw_user_email');
    if (!email) return false;
    for (var i = 0; i < FAMILIES.length; i++) {
      // Board roles are person-scoped — strict primary family_email match
      // so a co-parent doesn't pick up their spouse's role.
      if (String(FAMILIES[i].email || '').toLowerCase() === email.toLowerCase() && FAMILIES[i].boardRole) return true;
    }
    return false;
  }

  // Returns an array of teaching/assisting assignments for the current user
  // across all sessions. Used to pre-fill the curriculum editor.
  function getMyTeachingAssignments() {
    var email = localStorage.getItem('rw_user_email');
    if (!email) return [];
    var fam = null;
    for (var i = 0; i < FAMILIES.length; i++) {
      if (familyMatchesEmail(FAMILIES[i], email)) { fam = FAMILIES[i]; break; }
    }
    if (!fam) return [];
    var parentFullNames = (fam.parents || '').split(' & ').map(function (p) {
      return p.trim() + ' ' + fam.name;
    });
    function isMe(name) {
      if (!name) return false;
      var n = name.trim().toLowerCase();
      return parentFullNames.some(function (pf) { return pf.toLowerCase() === n; });
    }

    var assignments = [];
    var seen = {};
    function addOnce(key, obj) {
      if (seen[key]) return;
      seen[key] = true;
      assignments.push(obj);
    }

    // AM classes — every session
    Object.keys(AM_CLASSES || {}).forEach(function (groupName) {
      var staff = AM_CLASSES[groupName];
      if (!staff || !staff.sessions) return;
      Object.keys(staff.sessions).forEach(function (sessKey) {
        var sess = staff.sessions[sessKey];
        if (!sess) return;
        var role = null;
        if (isMe(sess.teacher)) role = 'Leading';
        else if ((sess.assistants || []).some(isMe)) role = 'Assisting';
        if (!role) return;
        addOnce('am-' + groupName + '-' + sessKey, {
          kind: 'AM',
          sessionNum: parseInt(sessKey, 10),
          role: role,
          name: groupName,
          topic: sess.topic || '',
          ageRange: groupName, // try to match the group label to an age range option
          description: sess.topic || ''
        });
      });
    });

    // PM electives — every session
    Object.keys(PM_ELECTIVES || {}).forEach(function (sessKey) {
      var rows = PM_ELECTIVES[sessKey] || [];
      rows.forEach(function (elec) {
        var role = null;
        if (isMe(elec.leader)) role = 'Leading';
        else if ((elec.assistants || []).some(isMe)) role = 'Assisting';
        if (!role) return;
        addOnce('pm-' + sessKey + '-' + elec.name, {
          kind: 'PM',
          sessionNum: parseInt(sessKey, 10),
          role: role,
          name: elec.name,
          topic: elec.description || '',
          ageRange: elec.ageRange || '',
          description: elec.description || ''
        });
      });
    });

    // Sort: most recent session first, then by name
    assignments.sort(function (a, b) {
      if (a.sessionNum !== b.sessionNum) return b.sessionNum - a.sessionNum;
      return a.name.localeCompare(b.name);
    });
    return assignments;
  }

  // Best-effort mapping of free-text age strings to one of AGE_RANGE_OPTIONS.
  function matchAgeRangeOption(raw) {
    if (!raw) return '';
    var s = String(raw).toLowerCase();
    // Direct exact match
    for (var i = 0; i < AGE_RANGE_OPTIONS.length; i++) {
      if (AGE_RANGE_OPTIONS[i].toLowerCase() === s) return AGE_RANGE_OPTIONS[i];
    }
    // Substring match against the option's label (e.g. "Oaks" → "Oaks (7-8)")
    for (var j = 0; j < AGE_RANGE_OPTIONS.length; j++) {
      var opt = AGE_RANGE_OPTIONS[j].toLowerCase();
      var optWord = opt.split(' (')[0]; // "saplings", "oaks", etc.
      if (s.indexOf(optWord) !== -1) return AGE_RANGE_OPTIONS[j];
    }
    // Common freeform patterns
    if (s.indexOf('all') !== -1) return 'All ages';
    return '';
  }

  function canEditCurriculum(curr) {
    if (!curr) return false;
    var email = localStorage.getItem('rw_user_email');
    if (!email) return false;
    if (curr.edit_policy === 'open') return true;
    if (curr.author_email === email) return true;
    if (currentUserIsBoard()) return true;
    return false;
  }

  function curriculumFetch(url, options) {
    return curriculumFetchInner(url, options, false);
  }

  function curriculumFetchInner(url, options, isRetry) {
    var cred = localStorage.getItem('rw_google_credential');
    options = options || {};
    options.headers = Object.assign({
      'Authorization': 'Bearer ' + cred,
      'Content-Type': 'application/json'
    }, options.headers || {});
    return fetch(url, options).then(function (r) {
      return r.json().then(function (data) {
        return { ok: r.ok, status: r.status, data: data };
      });
    }).then(function (res) {
      // 401 means the Google JWT is expired (they last ~1 hour). Try to
      // silently refresh once before giving up.
      if (res.status === 401 && !isRetry) {
        return refreshGoogleCredential().then(function (refreshed) {
          if (refreshed) {
            return curriculumFetchInner(url, options, true);
          }
          return res;
        });
      }
      return res;
    });
  }

  // Re-prompt Google to issue a new ID token without a full page reload.
  // Resolves true if a fresh credential is now in sessionStorage.
  function refreshGoogleCredential() {
    return new Promise(function (resolve) {
      if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) {
        resolve(false);
        return;
      }
      var oldCred = localStorage.getItem('rw_google_credential');
      var done = false;
      function check() {
        var c = localStorage.getItem('rw_google_credential');
        if (c && c !== oldCred) { done = true; resolve(true); }
      }
      // Watch for the existing Google sign-in callback to update sessionStorage
      var interval = setInterval(check, 200);
      setTimeout(function () { clearInterval(interval); if (!done) resolve(false); }, 8000);
      try {
        google.accounts.id.prompt(function (notification) {
          // notification.isNotDisplayed/isSkippedMoment etc. may fire
          if (notification && (notification.isNotDisplayed && notification.isNotDisplayed()) ||
              (notification && notification.isSkippedMoment && notification.isSkippedMoment())) {
            // user dismissed; we'll let the timeout resolve(false)
          }
        });
      } catch (e) {
        clearInterval(interval);
        resolve(false);
      }
    });
  }

  function loadCurriculumList() {
    return curriculumFetch('/api/curriculum').then(function (res) {
      if (!res.ok) { alert('Error loading curricula: ' + (res.data.error || 'unknown')); return; }
      curriculumState.list = res.data.curricula || [];
    });
  }

  function loadCurriculumDetail(id) {
    return curriculumFetch('/api/curriculum?id=' + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) { alert('Error loading plan: ' + (res.data.error || 'unknown')); return null; }
      return res.data.curriculum;
    });
  }

  function showCurriculumLibrary() {
    curriculumState.view = 'library';
    curriculumState.current = null;
    loadCurriculumList().then(function () { renderCurriculumModal(); });
  }

  function showCurriculumDetail(id) {
    loadCurriculumDetail(id).then(function (curr) {
      if (!curr) return;
      curriculumState.current = curr;
      curriculumState.view = 'detail';
      renderCurriculumModal();
    });
  }

  function renderCurriculumModal() {
    if (!personDetail || !personDetailCard) return;
    var html = '';
    if (curriculumState.view === 'detail') {
      // Unified modal header: Print lives next to the close X (same pattern
      // as Class Pack and duty-detail — see `.detail-actions` in styles.css).
      html += '<div class="detail-actions no-print">';
      html += '<button type="button" class="sc-btn" id="cl-print-btn" aria-label="Print">\u2399 Print</button>';
      html += '</div>';
    }
    html += '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail cl-modal">';

    if (curriculumState.view === 'library') {
      html += renderCurriculumLibraryBody();
    } else if (curriculumState.view === 'detail') {
      html += renderCurriculumDetailBody();
    } else if (curriculumState.view === 'editor') {
      html += renderCurriculumEditorBody();
    }

    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    wireCurriculumEvents();
  }

  // Draft autosave/restore — survives tab refresh and expired tokens.
  var DRAFT_NEW_KEY = 'rw_curriculum_draft_new';
  function draftKeyForId(id) { return 'rw_curriculum_draft_edit_' + id; }
  function currentDraftKey() {
    return curriculumState.editingId ? draftKeyForId(curriculumState.editingId) : DRAFT_NEW_KEY;
  }
  function autosaveDraft() {
    if (!curriculumState.draft || curriculumState.view !== 'editor') return;
    try {
      localStorage.setItem(currentDraftKey(), JSON.stringify({
        savedAt: Date.now(),
        editingId: curriculumState.editingId,
        draft: curriculumState.draft
      }));
    } catch (e) { /* quota — ignore */ }
  }
  function clearDraftAutosave() {
    try { localStorage.removeItem(currentDraftKey()); } catch (e) {}
  }
  function findRestorableDraft(forEditingId) {
    try {
      var raw = localStorage.getItem(forEditingId ? draftKeyForId(forEditingId) : DRAFT_NEW_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.draft) return null;
      // Drafts older than 7 days are stale
      if (Date.now() - (parsed.savedAt || 0) > 7 * 24 * 60 * 60 * 1000) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function startNewCurriculum() {
    loadClosetItemsForEditor().then(function () {
      var saved = findRestorableDraft(null);
      if (saved && confirm('Restore your unsaved lesson plan from ' + new Date(saved.savedAt).toLocaleString() + '?')) {
        curriculumState.draft = saved.draft;
      } else {
        if (saved) clearDraftAutosave();
        curriculumState.draft = blankDraft();
      }
      curriculumState.editingId = null;
      curriculumState.view = 'editor';
      renderCurriculumModal();
    });
  }

  function startEditCurriculum() {
    if (!curriculumState.current) return;
    loadClosetItemsForEditor().then(function () {
      var saved = findRestorableDraft(curriculumState.current.id);
      if (saved && confirm('You have unsaved changes from ' + new Date(saved.savedAt).toLocaleString() + '. Restore them?')) {
        curriculumState.draft = saved.draft;
      } else {
        if (saved) {
          try { localStorage.removeItem(draftKeyForId(curriculumState.current.id)); } catch (e) {}
        }
        curriculumState.draft = draftFromCurriculum(curriculumState.current);
      }
      curriculumState.editingId = curriculumState.current.id;
      curriculumState.view = 'editor';
      renderCurriculumModal();
    });
  }

  function copyAndEditCurriculum() {
    // POST /api/curriculum?id=N&action=copy, then open the new copy in the editor.
    if (!curriculumState.current) return;
    loadClosetItemsForEditor().then(function () {
      return curriculumFetch('/api/curriculum?id=' + encodeURIComponent(curriculumState.current.id) + '&action=copy', {
        method: 'POST'
      });
    }).then(function (res) {
      if (!res.ok) { alert('Copy failed: ' + (res.data.error || 'unknown')); return; }
      curriculumState.current = res.data.curriculum;
      curriculumState.draft = draftFromCurriculum(res.data.curriculum);
      curriculumState.editingId = res.data.curriculum.id;
      curriculumState.view = 'editor';
      renderCurriculumModal();
    });
  }

  function renderCurriculumEditorBody() {
    var d = curriculumState.draft;
    if (!d) return '<p>Loading...</p>';
    var isNew = !curriculumState.editingId;

    var html = '<div class="cl-detail-header">';
    html += '<button class="cl-back" id="cl-editor-cancel">&larr; Cancel</button>';
    html += '</div>';

    html += '<h3>' + (isNew ? 'New Lesson Plan' : 'Edit Lesson Plan') + '</h3>';

    // Datalist for supply autocomplete from the closet inventory
    var closet = curriculumState.closetItems || [];
    if (closet.length) {
      html += '<datalist id="cl-closet-items">';
      closet.forEach(function (it) {
        var hint = CATEGORY_LABEL(it.category) + (it.location ? ' · ' + it.location : '');
        html += '<option value="' + escapeAttr(it.item_name) + '">' + escapeAttr(hint) + '</option>';
      });
      html += '</datalist>';
    }

    // Pre-fill from a class the user is teaching (only when creating new)
    if (isNew) {
      var assignments = getMyTeachingAssignments();
      if (assignments.length > 0) {
        html += '<div class="cl-prefill">';
        html += '<label class="cl-label">Pre-fill from a class I\'m teaching <span class="cl-prefill-hint">(optional)</span>';
        html += '<select class="cl-input" id="cl-prefill-select"><option value="">— Start from scratch —</option>';
        assignments.forEach(function (a, idx) {
          var label = a.role + ': ' + a.name + ' (Session ' + a.sessionNum + ')';
          html += '<option value="' + idx + '">' + escapeAttr(label) + '</option>';
        });
        html += '</select></label>';
        html += '</div>';
      }
    }

    // Metadata section
    html += '<div class="cl-editor-meta">';
    html += '<label class="cl-label">Title<input class="cl-input" id="cl-f-title" value="' + escapeAttr(d.title) + '" placeholder="e.g. Clay Critters"></label>';

    html += '<div class="cl-editor-row">';
    html += '<label class="cl-label">Subject<select class="cl-input" id="cl-f-subject">';
    html += '<option value="">— Select —</option>';
    SUBJECT_OPTIONS.forEach(function (s) {
      html += '<option value="' + escapeAttr(s) + '"' + (d.subject === s ? ' selected' : '') + '>' + escapeAttr(s) + '</option>';
    });
    html += '</select></label>';
    html += '<label class="cl-label">Age Range<select class="cl-input" id="cl-f-age">';
    html += '<option value="">— Select —</option>';
    AGE_RANGE_OPTIONS.forEach(function (a) {
      html += '<option value="' + escapeAttr(a) + '"' + (d.age_range === a ? ' selected' : '') + '>' + escapeAttr(a) + '</option>';
    });
    html += '</select></label>';
    html += '<label class="cl-label">Block<select class="cl-input" id="cl-f-block">';
    var curBlock = d.block || '';
    html += '<option value=""' + (curBlock === '' ? ' selected' : '') + '>— Not set —</option>';
    html += '<option value="AM"' + (curBlock === 'AM' ? ' selected' : '') + '>AM (morning class)</option>';
    html += '<option value="PM"' + (curBlock === 'PM' ? ' selected' : '') + '>PM (afternoon elective)</option>';
    html += '<option value="both"' + (curBlock === 'both' ? ' selected' : '') + '>Works for AM or PM</option>';
    html += '</select></label>';
    html += '</div>';

    html += '<label class="cl-label">Overview<textarea class="cl-input cl-textarea" id="cl-f-overview" rows="3" placeholder="What will students learn across the whole unit?">' + escapeAttr(d.overview) + '</textarea></label>';

    html += '<label class="cl-label">Tags (comma-separated)<input class="cl-input" id="cl-f-tags" value="' + escapeAttr((d.tags || []).join(', ')) + '" placeholder="art, clay, sculpture"></label>';

    // "For which class?" picker
    var assignments = (typeof getMyTeachingAssignments === 'function') ? getMyTeachingAssignments() : [];
    var pendingLink = sessionStorage.getItem('rw_pending_class_link') || '';
    if (assignments.length > 0 || pendingLink) {
      html += '<label class="cl-label">For which class? (optional)<select class="cl-input" id="cl-f-class-key">';
      html += '<option value="">— Not linked to a class —</option>';
      assignments.forEach(function (a) {
        var key = a.kind === 'AM' ? a.name : 'PM:' + a.name;
        var label = a.name + (a.kind === 'PM' ? ' (PM)' : '') + ' \u2014 Session ' + a.sessionNum;
        var sel = (pendingLink && pendingLink === key) ? ' selected' : '';
        html += '<option value="' + key + ':' + a.sessionNum + '"' + sel + '>' + label + '</option>';
      });
      html += '</select></label>';
    }

    html += '<div class="cl-editor-row">';
    html += '<label class="cl-label">Number of Lessons<select class="cl-input" id="cl-f-lesson-count">';
    for (var i = 1; i <= 5; i++) {
      html += '<option value="' + i + '"' + (d.lesson_count === i ? ' selected' : '') + '>' + i + '</option>';
    }
    html += '</select></label>';
    html += '<label class="cl-label">Who can edit?<select class="cl-input" id="cl-f-edit-policy">';
    html += '<option value="author_only"' + (d.edit_policy === 'author_only' ? ' selected' : '') + '>Only me (+ board)</option>';
    html += '<option value="open"' + (d.edit_policy === 'open' ? ' selected' : '') + '>Anyone can edit</option>';
    html += '</select></label>';
    html += '</div>';
    html += '</div>';

    // Lesson sections
    html += '<div class="cl-editor-lessons">';
    for (var n = 0; n < d.lesson_count; n++) {
      html += renderLessonEditor(d.lessons[n], n);
    }
    html += '</div>';

    // Footer
    html += '<div class="cl-detail-actions">';
    html += '<button class="cl-action-btn" id="cl-editor-save-btn">' + (isNew ? 'Create Plan' : 'Save Changes') + '</button>';
    html += '</div>';

    return html;
  }

  function renderLessonEditor(lesson, idx) {
    // Make sure activity and instruction are paired before rendering.
    padPair(lesson.activity, lesson.instruction);

    var html = '<div class="cl-lesson cl-lesson-edit" data-lesson-idx="' + idx + '">';
    html += '<div class="cl-lesson-header">';
    html += '<span class="cl-lesson-num">Lesson ' + lesson.lesson_number + '</span>';
    html += '<input class="cl-input cl-lesson-title-input" data-field="title" placeholder="Lesson title" value="' + escapeAttr(lesson.title) + '">';
    html += '</div>';

    html += '<label class="cl-label cl-label-sm">Lesson overview<textarea class="cl-input cl-textarea" data-field="overview" rows="2" placeholder="What will kids learn this lesson?">' + escapeAttr(lesson.overview) + '</textarea></label>';

    // ── Room setup ──
    html += '<label class="cl-label cl-label-sm">Room setup<textarea class="cl-input cl-textarea" data-field="room_setup" rows="2" placeholder="How to arrange the room before kids arrive (tables, stations, materials laid out, etc.)">' + escapeAttr(lesson.room_setup || '') + '</textarea></label>';

    // ── Supplies ──
    html += '<div class="cl-dyn-section"><div class="cl-dyn-label">Supplies</div>';
    if (lesson.supplies.length === 0) {
      html += '<div class="cl-dyn-empty">No supplies yet.</div>';
    }
    lesson.supplies.forEach(function (s, si) {
      html += '<div class="cl-supply-row" data-supply-idx="' + si + '">';
      html += '<input class="cl-input cl-supply-name" data-sfield="item_name" placeholder="Item (type to search closet)" list="cl-closet-items" value="' + escapeAttr(s.item_name) + '">';
      html += '<input class="cl-input cl-supply-qty" data-sfield="qty" placeholder="Qty" value="' + escapeAttr(s.qty) + '">';
      html += '<select class="cl-input cl-supply-unit" data-sfield="qty_unit">';
      html += '<option value=""' + ((!s.qty_unit) ? ' selected' : '') + '>—</option>';
      html += '<option value="student"' + (s.qty_unit === 'student' ? ' selected' : '') + '>per student</option>';
      html += '<option value="class"' + (s.qty_unit === 'class' ? ' selected' : '') + '>per class</option>';
      html += '</select>';
      html += '<input class="cl-input cl-supply-notes" data-sfield="notes" placeholder="Notes" value="' + escapeAttr(s.notes) + '">';
      html += '<button class="cl-dyn-remove" data-dyn-remove="supplies" data-dyn-idx="' + si + '" type="button" title="Remove">&times;</button>';
      html += '</div>';
    });
    html += '<button class="cl-dyn-add" data-dyn-add="supplies" type="button">+ Add supply</button>';
    // (room setup moved above supplies)

    // Copy supplies from another lesson (only show if there is one)
    var otherLessons = [];
    for (var oi = 0; oi < curriculumState.draft.lesson_count; oi++) {
      if (oi === idx) continue;
      var ol = curriculumState.draft.lessons[oi];
      if (ol && ol.supplies && ol.supplies.length > 0) {
        otherLessons.push({ idx: oi, lesson: ol });
      }
    }
    if (otherLessons.length > 0) {
      html += '<select class="cl-input cl-supply-copy" data-target-lesson="' + idx + '" style="margin-left:0.5rem;max-width:240px;display:inline-block;width:auto;">';
      html += '<option value="">Copy supplies from…</option>';
      otherLessons.forEach(function (o) {
        var label = 'Lesson ' + (o.idx + 1) + (o.lesson.title ? ': ' + o.lesson.title : '') + ' (' + o.lesson.supplies.length + ')';
        html += '<option value="' + o.idx + '">' + escapeAttr(label) + '</option>';
      });
      html += '</select>';
    }
    html += '</div>';

    // ── Activity & Instruction (parallel numbered rows) ──
    html += '<div class="cl-dyn-section">';
    html += '<div class="cl-steps-headers">';
    html += '<span class="cl-dyn-bullet"></span>';
    html += '<div class="cl-dyn-label cl-steps-col">Activity</div>';
    html += '<div class="cl-dyn-label cl-steps-col">Leader notes</div>';
    html += '<span class="cl-steps-spacer"></span>';
    html += '</div>';
    lesson.activity.forEach(function (val, i) {
      html += '<div class="cl-steps-row" data-step-idx="' + i + '">';
      html += '<span class="cl-dyn-bullet">' + (i + 1) + '.</span>';
      html += '<textarea class="cl-input cl-textarea cl-step-cell" data-step-field="activity" data-step-idx="' + i + '" rows="3" placeholder="What kids do">' + escapeAttr(val) + '</textarea>';
      html += '<textarea class="cl-input cl-textarea cl-step-cell" data-step-field="instruction" data-step-idx="' + i + '" rows="3" placeholder="What leader says / does">' + escapeAttr(lesson.instruction[i] || '') + '</textarea>';
      html += '<button class="cl-dyn-remove" data-dyn-remove="step-pair" data-dyn-idx="' + i + '" type="button" title="Remove step">&times;</button>';
      html += '</div>';
    });
    html += '<button class="cl-dyn-add" data-dyn-add="step-pair" type="button">+ Add step</button>';
    html += '</div>';

    // ── Links / references ──
    html += '<div class="cl-dyn-section"><div class="cl-dyn-label">References (links)</div>';
    if (lesson.links.length === 0) {
      html += '<div class="cl-dyn-empty">No links yet.</div>';
    }
    lesson.links.forEach(function (l, li) {
      html += '<div class="cl-link-row" data-link-idx="' + li + '">';
      html += '<input class="cl-input cl-link-label" data-lfield="label" placeholder="Label" value="' + escapeAttr(l.label) + '">';
      html += '<input class="cl-input cl-link-url" data-lfield="url" placeholder="https://..." value="' + escapeAttr(l.url) + '">';
      html += '<button class="cl-dyn-remove" data-dyn-remove="links" data-dyn-idx="' + li + '" type="button" title="Remove">&times;</button>';
      html += '</div>';
    });
    html += '<button class="cl-dyn-add" data-dyn-add="links" type="button">+ Add link</button>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  function renderDynamicList(field, label, items) {
    var html = '<div class="cl-dyn-section"><div class="cl-dyn-label">' + label + '</div>';
    if (items.length === 0) items = [''];
    items.forEach(function (val, i) {
      html += '<div class="cl-dyn-row" data-dyn-idx="' + i + '">';
      html += '<span class="cl-dyn-bullet">' + (i + 1) + '.</span>';
      html += '<textarea class="cl-input cl-textarea cl-dyn-textarea" data-dyn-field="' + field + '" data-dyn-idx="' + i + '" rows="2" placeholder="Step ' + (i + 1) + '">' + escapeAttr(val) + '</textarea>';
      html += '<button class="cl-dyn-remove" data-dyn-remove="' + field + '" data-dyn-idx="' + i + '" type="button" title="Remove">&times;</button>';
      html += '</div>';
    });
    html += '<button class="cl-dyn-add" data-dyn-add="' + field + '" type="button">+ Add step</button>';
    html += '</div>';
    return html;
  }

  function gatherEditorDraftFromForm() {
    // Pull all form values back into state.draft so surgical re-renders and saves
    // use the latest user input without losing anything.
    var d = curriculumState.draft;
    if (!d) return;

    var titleEl = personDetailCard.querySelector('#cl-f-title');
    var subjEl = personDetailCard.querySelector('#cl-f-subject');
    var ageEl = personDetailCard.querySelector('#cl-f-age');
    var blockEl = personDetailCard.querySelector('#cl-f-block');
    var overviewEl = personDetailCard.querySelector('#cl-f-overview');
    var tagsEl = personDetailCard.querySelector('#cl-f-tags');
    var lcEl = personDetailCard.querySelector('#cl-f-lesson-count');
    var polEl = personDetailCard.querySelector('#cl-f-edit-policy');

    if (titleEl) d.title = titleEl.value;
    if (subjEl) d.subject = subjEl.value;
    if (ageEl) d.age_range = ageEl.value;
    if (blockEl) d.block = blockEl.value;
    if (overviewEl) d.overview = overviewEl.value;
    if (tagsEl) d.tags = tagsEl.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    if (lcEl) d.lesson_count = parseInt(lcEl.value, 10) || 5;
    if (polEl) d.edit_policy = polEl.value;

    // Lesson-level fields
    personDetailCard.querySelectorAll('.cl-lesson-edit').forEach(function (lessonEl) {
      var idx = parseInt(lessonEl.getAttribute('data-lesson-idx'), 10);
      var lesson = d.lessons[idx];
      if (!lesson) return;

      var titleInput = lessonEl.querySelector('input[data-field="title"]');
      if (titleInput) lesson.title = titleInput.value;
      var overviewInput = lessonEl.querySelector('textarea[data-field="overview"]');
      if (overviewInput) lesson.overview = overviewInput.value;
      var setupInput = lessonEl.querySelector('textarea[data-field="room_setup"]');
      if (setupInput) lesson.room_setup = setupInput.value;

      // Activity & Instruction (parallel rows by index)
      var stepRows = lessonEl.querySelectorAll('.cl-steps-row');
      var act = [];
      var ins = [];
      stepRows.forEach(function (row) {
        var a = row.querySelector('[data-step-field="activity"]');
        var i = row.querySelector('[data-step-field="instruction"]');
        act.push(a ? a.value : '');
        ins.push(i ? i.value : '');
      });
      lesson.activity = act;
      lesson.instruction = ins;

      // Supplies
      var supplyRows = lessonEl.querySelectorAll('.cl-supply-row');
      var supplies = [];
      supplyRows.forEach(function (row) {
        var rawName = (row.querySelector('[data-sfield="item_name"]') || {}).value || '';
        var itemName = capitalizeFirstLetter(rawName);
        // Auto-link to supply closet by matching item name
        var closetId = null;
        if (curriculumState.closetItems && itemName) {
          var lowerName = itemName.toLowerCase().trim();
          for (var ci = 0; ci < curriculumState.closetItems.length; ci++) {
            if ((curriculumState.closetItems[ci].item_name || '').toLowerCase().trim() === lowerName) {
              closetId = curriculumState.closetItems[ci].id;
              break;
            }
          }
        }
        supplies.push({
          item_name: itemName,
          qty: (row.querySelector('[data-sfield="qty"]') || {}).value || '',
          qty_unit: (row.querySelector('[data-sfield="qty_unit"]') || {}).value || '',
          notes: (row.querySelector('[data-sfield="notes"]') || {}).value || '',
          closet_item_id: closetId
        });
      });
      lesson.supplies = supplies;

      // Links
      var linkRows = lessonEl.querySelectorAll('.cl-link-row');
      var links = [];
      linkRows.forEach(function (row) {
        links.push({
          label: (row.querySelector('[data-lfield="label"]') || {}).value || '',
          url: (row.querySelector('[data-lfield="url"]') || {}).value || ''
        });
      });
      lesson.links = links;
    });
  }

  function saveCurriculumDraft() {
    gatherEditorDraftFromForm();
    var d = curriculumState.draft;
    if (!d.title || !d.title.trim()) {
      alert('Title is required.');
      return;
    }
    // Trim the lessons array down to lesson_count before sending
    var payload = {
      title: d.title,
      subject: d.subject,
      age_range: d.age_range,
      block: d.block || '',
      overview: d.overview,
      tags: d.tags,
      edit_policy: d.edit_policy,
      lesson_count: d.lesson_count,
      lessons: d.lessons.slice(0, d.lesson_count)
    };

    var saveBtn = personDetailCard.querySelector('#cl-editor-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

    var id = curriculumState.editingId;
    var url = '/api/curriculum' + (id ? '?id=' + encodeURIComponent(id) : '');
    var method = id ? 'PATCH' : 'POST';

    curriculumFetch(url, {
      method: method,
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) {
        var msg = res.status === 401
          ? 'Save failed: your sign-in expired. Please refresh and sign in again. Your draft is auto-saved in this browser.'
          : 'Save failed: ' + (res.data.error || 'unknown');
        alert(msg);
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = id ? 'Save Changes' : 'Create Plan'; }
        return;
      }
      clearDraftAutosave();
      curriculumState.current = res.data.curriculum;
      curriculumState.draft = null;
      curriculumState.editingId = null;
      curriculumState.view = 'detail';

      // Auto-link to class if one was selected
      var classKeyEl = personDetailCard.querySelector('#cl-f-class-key');
      var classVal = classKeyEl ? classKeyEl.value : '';
      var pendingLink = sessionStorage.getItem('rw_pending_class_link');
      sessionStorage.removeItem('rw_pending_class_link');
      if (classVal && res.data.curriculum) {
        var parts = classVal.split(':');
        var linkSession = parseInt(parts[parts.length - 1], 10);
        var linkKey = parts.slice(0, -1).join(':');
        if (linkKey && linkSession) {
          var cred = localStorage.getItem('rw_google_credential');
          fetch('/api/curriculum?action=link', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_number: linkSession, class_key: linkKey, curriculum_id: res.data.curriculum.id })
          }).then(function () { if (typeof loadClassLinks === 'function') loadClassLinks(); }).catch(function () {});
        }
      }

      renderCurriculumModal();
    });
  }

  function renderCurriculumLibraryBody() {
    var state = curriculumState;
    var html = '<h3>Curriculum Library</h3>';
    html += '<p class="cl-intro">Browse shared lesson plans, or create your own. Each plan has up to 5 lessons and a supply list.</p>';

    // Controls
    html += '<div class="cl-controls">';
    html += '<input type="text" class="cl-search" id="cl-search-input" placeholder="Search plans..." value="' + escapeAttr(state.searchQuery) + '">';
    html += '<button class="cl-create" id="cl-create-btn">+ Create New Plan</button>';
    html += '</div>';

    // Grid of plan cards
    var rows = (state.list || []).filter(function (c) {
      if (!state.searchQuery) return true;
      var q = state.searchQuery.toLowerCase();
      return (
        (c.title || '').toLowerCase().indexOf(q) !== -1 ||
        (c.subject || '').toLowerCase().indexOf(q) !== -1 ||
        (c.age_range || '').toLowerCase().indexOf(q) !== -1 ||
        (c.overview || '').toLowerCase().indexOf(q) !== -1 ||
        ((c.tags || []).join(' ')).toLowerCase().indexOf(q) !== -1
      );
    });

    html += '<div class="cl-count">' + rows.length + ' plan' + (rows.length === 1 ? '' : 's') + '</div>';
    html += '<div class="cl-grid">';
    if (state.list === null) {
      html += '<div class="cl-empty">Loading...</div>';
    } else if (rows.length === 0) {
      html += '<div class="cl-empty">No plans yet. Click "Create New Plan" to add the first one!</div>';
    } else {
      rows.forEach(function (c) {
        html += '<button class="cl-card" data-id="' + c.id + '">';
        // Badges strip — block (AM/PM/both) + favorite star
        var badges = '';
        if (c.block === 'AM') badges += '<span class="cl-badge cl-badge-am">AM</span>';
        else if (c.block === 'PM') badges += '<span class="cl-badge cl-badge-pm">PM</span>';
        else if (c.block === 'both') badges += '<span class="cl-badge cl-badge-both">AM/PM</span>';
        if (c.is_favorite) badges += '<span class="cl-badge cl-badge-fav" title="Kid favorite">⭐ Favorite</span>';
        if (badges) html += '<div class="cl-card-badges">' + badges + '</div>';
        html += '<div class="cl-card-title">' + escapeAttr(c.title) + '</div>';
        var meta = [];
        if (c.subject) meta.push(escapeAttr(c.subject));
        if (c.age_range) {
          var ageStr = c.age_range.toLowerCase().indexOf('all') !== -1 || c.age_range.toLowerCase().indexOf('mixed') !== -1
            ? c.age_range
            : 'Ages ' + c.age_range;
          meta.push(escapeAttr(ageStr));
        }
        if (c.lesson_count) meta.push(c.lesson_count + ' lesson' + (c.lesson_count === 1 ? '' : 's'));
        if (meta.length) html += '<div class="cl-card-meta">' + meta.join(' &middot; ') + '</div>';
        if (c.overview) html += '<div class="cl-card-overview">' + escapeAttr(c.overview.slice(0, 140)) + (c.overview.length > 140 ? '...' : '') + '</div>';
        html += '<div class="cl-card-author">by ' + escapeAttr(c.author_name || c.author_email) + '</div>';
        html += '</button>';
      });
    }
    html += '</div>';

    return html;
  }

  function buildPrintHtml(curr) {
    if (!curr) return '<p>Nothing to print.</p>';

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Build aggregated supply list grouped by source
    var rows = aggregateSupplyRows(curr);

    var css = [
      '@page { margin: 0.5in; }',
      '* { box-sizing: border-box; }',
      'body { font-family: Georgia, serif; color: #000; max-width: 7.5in; margin: 0 auto; padding: 0.25in; line-height: 1.4; }',
      'h1 { font-size: 22pt; margin: 0 0 4pt 0; padding-bottom: 6pt; border-bottom: 2pt solid #333; }',
      '.meta { color: #555; font-size: 10pt; margin-bottom: 8pt; }',
      '.author { color: #555; font-size: 9pt; font-style: italic; margin-bottom: 12pt; }',
      '.overview { background: #f5f5f5; padding: 8pt 12pt; border-left: 3pt solid #333; font-size: 11pt; margin-bottom: 14pt; }',
      '.master { border: 1.5pt solid #333; padding: 10pt 14pt; margin-bottom: 16pt; page-break-inside: avoid; }',
      '.master h2 { font-size: 13pt; margin: 0 0 4pt 0; }',
      '.master .sub { font-size: 9pt; color: #555; font-style: italic; margin: 0 0 6pt 0; }',
      '.master .source-group { margin-bottom: 8pt; }',
      '.master .source-heading { font-size: 10pt; font-weight: 700; margin: 6pt 0 3pt 0; padding-bottom: 2pt; border-bottom: 0.5pt solid #999; }',
      '.loc-group { margin-bottom: 4pt; }',
      '.loc-label { font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #555; margin: 4pt 0 1pt 0; }',
      '.master ul { columns: 2; column-gap: 18pt; list-style: none; padding: 0; margin: 0; }',
      '.master li { padding-left: 18pt; text-indent: -18pt; margin-bottom: 4pt; font-size: 10pt; line-height: 1.35; break-inside: avoid; }',
      '.master li::before { content: "☐  "; font-size: 13pt; }',
      '.master .lessons, .master .qty, .master .notes { color: #555; font-size: 9pt; }',
      '.lesson { border: 1pt solid #333; padding: 12pt 14pt; margin-bottom: 14pt; page-break-inside: avoid; }',
      '.lesson-header { display: flex; align-items: baseline; gap: 8pt; padding-bottom: 4pt; border-bottom: 1pt solid #333; margin-bottom: 8pt; }',
      '.lesson-num { background: #333; color: #fff; padding: 2pt 8pt; font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }',
      '.lesson-title { font-size: 13pt; font-weight: 700; }',
      '.lesson-overview { font-style: italic; color: #444; font-size: 10pt; margin: 0 0 8pt 0; }',
      '.section { margin-bottom: 8pt; font-size: 10pt; }',
      '.section h3 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 3pt 0; color: #000; }',
      '.section ul { list-style: none; padding: 0; margin: 0; }',
      '.section ul.checks li { padding-left: 18pt; text-indent: -18pt; margin-bottom: 3pt; }',
      '.section ul.checks li::before { content: "☐  "; font-size: 13pt; }',
      '.steps { display: grid; grid-template-columns: 44pt 1fr 1fr; gap: 12pt; }',
      '.steps .header { font-weight: 700; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em; padding-bottom: 4pt; border-bottom: 1pt solid #333; }',
      '.steps .num { text-align: right; padding-right: 4pt; font-weight: 700; }',
      '.steps .cell { padding: 4pt 0; border-bottom: 0.5pt solid #ccc; }',
      '.qty { color: #555; font-size: 9pt; }',
      '.notes { color: #555; font-size: 9pt; font-style: italic; }',
      '.low-flag { display: inline-block; font-size: 11pt; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; padding: 5pt 14pt; border-radius: 999pt; margin-left: 10pt; line-height: 1; vertical-align: 1pt; background: #e07a2a; color: #fff; box-shadow: 0 1pt 2pt rgba(0,0,0,0.15); text-indent: 0; }',
      '.low-flag-empty { background: #c0392b; }',
      '@media print { .low-flag { background: transparent !important; color: #000; border: 0.5pt solid #000; box-shadow: none !important; } }',
      '@media print { .no-print { display: none; } }',
      '.no-print { text-align: center; padding: 12pt; background: #ffe; border-bottom: 1pt solid #ccc; margin: -0.25in -0.25in 12pt -0.25in; }',
      '.no-print button { font-size: 11pt; padding: 6pt 16pt; cursor: pointer; }'
    ].join('\n');

    var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(curr.title) + '</title><style>' + css + '</style></head><body>';
    html += '<div class="no-print"><button onclick="window.print()">Print</button> · <button onclick="window.close()">Close</button></div>';

    html += '<h1>' + esc(curr.title) + '</h1>';
    var metaParts = [];
    if (curr.subject) metaParts.push(esc(curr.subject));
    if (curr.age_range) {
      var ageLow = curr.age_range.toLowerCase();
      metaParts.push(esc((ageLow.indexOf('all') !== -1 || ageLow.indexOf('mixed') !== -1) ? curr.age_range : 'Ages ' + curr.age_range));
    }
    metaParts.push((curr.lesson_count || 0) + ' lesson' + (curr.lesson_count === 1 ? '' : 's'));
    html += '<div class="meta">' + metaParts.join(' · ') + '</div>';
    html += '<div class="author">by ' + esc(curr.author_name || curr.author_email) + '</div>';
    if (curr.overview) html += '<div class="overview">' + esc(curr.overview) + '</div>';

    // Master supply list grouped by location
    if (rows.length) {
      var groups = groupSupplyRowsByLocation(rows);

      html += '<div class="master"><h2>Master Supply List</h2><p class="sub">Everything needed across all lessons — grouped by where to find it.</p>';
      groups.forEach(function (g) {
        html += '<div class="source-group"><div class="source-heading">' + esc(g.heading) + '</div><ul>';
        g.items.forEach(function (r) {
          var bits = [];
          if (r.qty) bits.push(esc(r.qty));
          if (r.unit === 'student') bits.push('per student');
          else if (r.unit === 'class') bits.push('per class');
          var qtyStr = bits.length ? ' <span class="qty">(' + bits.join(' ') + ')</span>' : '';
          var lessonsStr = ' <span class="lessons">· L' + r.lessons.join(',') + '</span>';
          var notesStr = r.notes ? ' <span class="notes">— ' + esc(r.notes) + '</span>' : '';
          var flagStr2 = '';
          if (r.closet_needs_restock || r.closet_quantity_level === 'empty') flagStr2 = ' <span class="low-flag' + (r.closet_quantity_level === 'empty' ? ' low-flag-empty' : '') + '">' + (r.closet_quantity_level === 'empty' ? 'Empty' : 'Low') + '</span>';
          else if (r.closet_quantity_level === 'low') flagStr2 = ' <span class="low-flag">Low</span>';
          html += '<li><strong>' + esc(r.name) + '</strong>' + flagStr2 + qtyStr + lessonsStr + notesStr + '</li>';
        });
        html += '</ul></div>';
      });
      html += '</div>';
    }

    // Each lesson
    (curr.lessons || []).forEach(function (ls) {
      html += '<div class="lesson">';
      html += '<div class="lesson-header"><span class="lesson-num">Lesson ' + ls.lesson_number + '</span>';
      if (ls.title) html += '<span class="lesson-title">' + esc(ls.title) + '</span>';
      html += '</div>';
      if (ls.overview) html += '<p class="lesson-overview">' + esc(ls.overview) + '</p>';

      if (ls.room_setup) {
        html += '<div class="section"><h3>Room setup</h3><p style="margin:0;">' + esc(ls.room_setup) + '</p></div>';
      }

      if (ls.supplies && ls.supplies.length) {
        html += '<div class="section"><h3>Supplies</h3>';
        var pGroups = groupLessonSuppliesByLocation(ls.supplies);
        pGroups.forEach(function (g) {
          html += '<div class="loc-group"><div class="loc-label">' + esc(g.heading) + '</div><ul class="checks">';
          g.items.forEach(function (s) {
            var line = '<strong>' + esc(s.item_name) + '</strong>';
            if (s.closet_needs_restock || s.closet_quantity_level === 'empty') {
              line += ' <span class="low-flag' + (s.closet_quantity_level === 'empty' ? ' low-flag-empty' : '') + '">' + (s.closet_quantity_level === 'empty' ? 'Empty' : 'Low') + '</span>';
            } else if (s.closet_quantity_level === 'low') {
              line += ' <span class="low-flag">Low</span>';
            }
            var bits = [];
            if (s.qty) bits.push(esc(s.qty));
            if (s.qty_unit === 'student') bits.push('per student');
            else if (s.qty_unit === 'class') bits.push('per class');
            if (bits.length) line += ' <span class="qty">(' + bits.join(' ') + ')</span>';
            if (s.notes) line += ' <span class="notes">— ' + esc(s.notes) + '</span>';
            html += '<li>' + line + '</li>';
          });
          html += '</ul></div>';
        });
        html += '</div>';
      }

      var actArr = ls.activity || [];
      var insArr = ls.instruction || [];
      var maxSteps = Math.max(actArr.length, insArr.length);
      if (maxSteps > 0) {
        html += '<div class="section" style="margin-top:10pt;"><div class="steps">';
        html += '<div class="header">Steps</div><div class="header">Activity</div><div class="header">Leader notes</div>';
        for (var i = 0; i < maxSteps; i++) {
          var aText = actArr[i] || '';
          var iText = insArr[i] || '';
          if (!aText && !iText) continue;
          html += '<div class="cell num">' + (i + 1) + '.</div>';
          html += '<div class="cell">' + esc(aText) + '</div>';
          html += '<div class="cell">' + esc(iText) + '</div>';
        }
        html += '</div></div>';
      }

      if (ls.links && ls.links.length) {
        html += '<div class="section"><h3>References</h3><ul>';
        ls.links.forEach(function (l) {
          html += '<li><a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + esc(l.label || l.url) + '</a></li>';
        });
        html += '</ul></div>';
      }
      html += '</div>';
    });

    html += '</body></html>';
    return html;
  }

  function printCurriculumInNewWindow(curr) {
    if (!curr) return;
    openPrintIframe(buildPrintHtml(curr));
  }

  var BUY_FIND_KEY = '__buy_find__';

  function aggregateSupplyRows(curr) {
    // Aggregate supplies across all lessons. Match case-insensitively and
    // collapse extra whitespace so "Brayer" / "brayer" / "Brayer " merge.
    function norm(s) { return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); }

    var lessons = curr.lessons || [];
    var rows = [];
    var keyToRow = {};
    lessons.forEach(function (ls) {
      (ls.supplies || []).forEach(function (s) {
        var name = String(s.item_name || '').trim().replace(/\s+/g, ' ');
        if (!name) return;
        var qty = String(s.qty || '').trim();
        var unit = s.qty_unit || '';
        var notes = String(s.notes || '').trim().replace(/\s+/g, ' ');
        // Location comes from the linked supply closet item
        var location = s.closet_location || '';
        var sig = norm(name);
        if (keyToRow[sig]) {
          if (keyToRow[sig].lessons.indexOf(ls.lesson_number) === -1) {
            keyToRow[sig].lessons.push(ls.lesson_number);
          }
        } else {
          var row = { name: name, qty: qty, unit: unit, location: location, notes: notes, lessons: [ls.lesson_number], id: s.id || null, closet_item_id: s.closet_item_id, closet_needs_restock: !!s.closet_needs_restock, closet_quantity_level: s.closet_quantity_level || null };
          keyToRow[sig] = row;
          rows.push(row);
        }
      });
    });
    rows.forEach(function (r) { r.lessons.sort(function (a, b) { return a - b; }); });
    return rows;
  }

  // Returns a small pill (or '') warning that a closet-linked supply is
  // currently flagged as needing restock, or that the coordinator has marked
  // its quantity as empty/low. Takes either a raw supply object (per-lesson
  // shape with closet_needs_restock/closet_quantity_level) or a master-list
  // row that has been enriched with the same two fields.
  function renderSupplyLowPill(s) {
    if (!s) return '';
    var flagged = !!s.closet_needs_restock;
    var level = s.closet_quantity_level;
    if (flagged) return ' <span class="cl-sup-flag cl-sup-flag-low" title="Flagged as needing restock">Low</span>';
    if (level === 'empty') return ' <span class="cl-sup-flag cl-sup-flag-empty" title="Marked empty by Supply Coordinator">Empty</span>';
    if (level === 'low') return ' <span class="cl-sup-flag cl-sup-flag-low" title="Marked low by Supply Coordinator">Low</span>';
    return '';
  }

  function renderSupplyItem(r, opts) {
    var esc = opts && opts.esc || escapeAttr;
    var linkifyFn = opts && opts.linkify || linkify;
    var bits = [];
    if (r.qty) bits.push(esc(r.qty));
    if (r.unit === 'student') bits.push('per student');
    else if (r.unit === 'class') bits.push('per class');
    var qtyStr = bits.length ? ' <span class="' + (opts && opts.qtyClass || 'cl-qty') + '">(' + bits.join(' ') + ')</span>' : '';
    var lessonsStr = '<span class="' + (opts && opts.lessonsClass || 'cl-master-lessons') + '"> · L' + r.lessons.join(',') + '</span>';
    var notesStr = r.notes ? ' <span class="' + (opts && opts.notesClass || 'cl-notes') + '">— ' + linkifyFn(r.notes) + '</span>' : '';
    return '<span class="' + (opts && opts.nameClass || 'cl-master-name') + '">' + esc(r.name) + '</span>' + renderSupplyLowPill(r) + qtyStr + lessonsStr + notesStr;
  }

  function groupLessonSuppliesByLocation(supplies) {
    // Group a single lesson's supplies by closet_location
    var locGroups = {};
    var locOrder = [];
    var buyFind = [];
    var CLOSET_FALLBACK = 'Supply Closet';

    supplies.forEach(function (s) {
      if (s.closet_item_id) {
        var loc = s.closet_location || CLOSET_FALLBACK;
        if (!locGroups[loc]) {
          locGroups[loc] = [];
          locOrder.push(loc);
        }
        locGroups[loc].push(s);
      } else {
        buyFind.push(s);
      }
    });

    locOrder.sort(function (a, b) { return a.localeCompare(b); });

    var result = [];
    locOrder.forEach(function (loc) {
      result.push({ heading: loc, items: locGroups[loc] });
    });
    if (buyFind.length) {
      result.push({ heading: 'Buy / Find', items: buyFind });
    }
    return result;
  }

  function groupSupplyRowsByLocation(rows) {
    // Group: each unique closet location gets a group, plus "Buy / Find" for non-closet items
    var locGroups = {};
    var locOrder = [];
    var buyFind = [];
    var CLOSET_FALLBACK = 'Supply Closet';

    rows.forEach(function (r) {
      if (r.closet_item_id) {
        var loc = r.location || CLOSET_FALLBACK;
        if (!locGroups[loc]) {
          locGroups[loc] = [];
          locOrder.push(loc);
        }
        locGroups[loc].push(r);
      } else {
        buyFind.push(r);
      }
    });

    // Sort location groups alphabetically
    locOrder.sort(function (a, b) { return a.localeCompare(b); });

    var result = [];
    locOrder.forEach(function (loc) {
      result.push({ heading: loc, items: locGroups[loc] });
    });
    if (buyFind.length) {
      result.push({ heading: 'Buy / Find', items: buyFind });
    }
    return result;
  }

  function renderMasterSupplyList(curr) {
    var rows = aggregateSupplyRows(curr);
    if (rows.length === 0) return '';

    var groups = groupSupplyRowsByLocation(rows);

    var html = '<div class="cl-master-supplies">';
    html += '<details class="cl-master-details" open>';
    html += '<summary class="cl-master-summary"><span class="cl-master-title">Master Supply List</span> <span class="cl-master-count">' + rows.length + ' item' + (rows.length === 1 ? '' : 's') + '</span></summary>';
    html += '<p class="cl-master-sub">Everything needed across all lessons — grouped by where to find it.</p>';

    groups.forEach(function (g) {
      html += '<div class="cl-source-group">';
      html += '<h4 class="cl-source-heading">' + escapeAttr(g.heading) + '</h4>';
      html += '<ul class="cl-master-list">';
      g.items.forEach(function (r) {
        html += '<li class="cl-master-item">' + renderSupplyItem(r) + '</li>';
      });
      html += '</ul></div>';
    });

    html += '</details>';
    html += '</div>';
    return html;
  }

  function renderCurriculumDetailBody() {
    var curr = curriculumState.current;
    if (!curr) return '<p>Loading...</p>';
    var canEdit = canEditCurriculum(curr);

    var html = '<div class="cl-detail-header">';
    html += '<button class="cl-back" id="cl-back-btn">&larr; Library</button>';
    html += '</div>';

    html += '<div class="cl-title-row">';
    html += '<h3>' + escapeAttr(curr.title) + '</h3>';
    // Reviewer-only ⭐ favorite star, inline with the title. Yellow when
    // favorited, outlined white when not. Silent for non-reviewers.
    if (classSubmissionReviewer) {
      var favActive = !!curr.is_favorite;
      var favLabel = favActive ? 'Remove favorite' : 'Mark as favorite';
      html += '<button class="cl-fav-star' + (favActive ? ' is-fav' : '') + '"'
        + ' id="cl-fav-btn-top" data-id="' + curr.id + '"'
        + ' data-fav="' + (favActive ? '1' : '0') + '"'
        + ' aria-label="' + favLabel + '" title="' + favLabel + '">';
      // Filled when favorited, outlined when not.
      html += '<svg viewBox="0 0 24 24" width="26" height="26" fill="' + (favActive ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">';
      html += '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>';
      html += '</svg>';
      html += '</button>';
    }
    html += '</div>';
    // Block badge under the title — favorite status now lives on the star.
    var detailBadges = '';
    if (curr.block === 'AM') detailBadges += '<span class="cl-badge cl-badge-am">AM Class</span>';
    else if (curr.block === 'PM') detailBadges += '<span class="cl-badge cl-badge-pm">PM Elective</span>';
    else if (curr.block === 'both') detailBadges += '<span class="cl-badge cl-badge-both">AM or PM</span>';
    if (detailBadges) html += '<div class="cl-detail-badges">' + detailBadges + '</div>';

    html += '<div class="cl-detail-actions cl-detail-actions-top">';
    html += '<button class="cl-action-btn" id="cl-copy-btn-top" data-id="' + curr.id + '">Copy &amp; Modify</button>';
    if (canEdit) {
      html += '<button class="cl-action-btn" id="cl-edit-btn-top" data-id="' + curr.id + '">Edit</button>';
      html += '<button class="cl-action-btn cl-action-del" id="cl-delete-btn-top" data-id="' + curr.id + '">Delete</button>';
    }
    html += '</div>';
    var metaParts = [];
    if (curr.subject) metaParts.push(escapeAttr(curr.subject));
    if (curr.age_range) {
      // Don't say "Ages All ages"; the option already reads naturally
      var ageStr = curr.age_range.toLowerCase().indexOf('all') !== -1 || curr.age_range.toLowerCase().indexOf('mixed') !== -1
        ? curr.age_range
        : 'Ages ' + curr.age_range;
      metaParts.push(escapeAttr(ageStr));
    }
    metaParts.push(curr.lesson_count + ' lesson' + (curr.lesson_count === 1 ? '' : 's'));
    html += '<div class="cl-detail-meta">' + metaParts.join(' &middot; ') + '</div>';
    html += '<div class="cl-detail-author">by ' + escapeAttr(curr.author_name || curr.author_email) + '</div>';

    if (curr.overview) {
      html += '<p class="cl-detail-overview">' + escapeAttr(curr.overview) + '</p>';
    }

    if (curr.tags && curr.tags.length) {
      html += '<div class="cl-tags">';
      curr.tags.forEach(function (t) { html += '<span class="cl-tag">' + escapeAttr(t) + '</span>'; });
      html += '</div>';
    }

    // ── Master Supply List (aggregated across all lessons) ──
    html += renderMasterSupplyList(curr);

    // Lessons
    html += '<div class="cl-lessons">';
    (curr.lessons || []).forEach(function (ls) {
      html += '<div class="cl-lesson">';
      html += '<div class="cl-lesson-header"><span class="cl-lesson-num">Lesson ' + ls.lesson_number + '</span>';
      if (ls.title) html += '<span class="cl-lesson-title">' + escapeAttr(ls.title) + '</span>';
      html += '</div>';
      if (ls.overview) html += '<p class="cl-lesson-overview">' + escapeAttr(ls.overview) + '</p>';

      // Room setup
      if (ls.room_setup) {
        html += '<div class="cl-lesson-section"><strong>Room setup</strong><p class="cl-room-setup">' + escapeAttr(ls.room_setup) + '</p></div>';
      }

      // Supplies — grouped by location
      if (ls.supplies && ls.supplies.length) {
        html += '<div class="cl-lesson-section"><strong>Supplies</strong>';
        var lessonGroups = groupLessonSuppliesByLocation(ls.supplies);
        lessonGroups.forEach(function (g) {
          html += '<div class="cl-loc-group"><span class="cl-loc-label">' + escapeAttr(g.heading) + '</span><ul class="cl-supply-list">';
          g.items.forEach(function (s) {
            var line = escapeAttr(s.item_name) + renderSupplyLowPill(s);
            var qtyParts = [];
            if (s.qty) qtyParts.push(escapeAttr(s.qty));
            if (s.qty_unit === 'student') qtyParts.push('per student');
            else if (s.qty_unit === 'class') qtyParts.push('per class');
            if (qtyParts.length) line += ' <span class="cl-qty">(' + qtyParts.join(' ') + ')</span>';
            if (s.notes) line += ' <span class="cl-notes">&mdash; ' + linkify(s.notes) + '</span>';
            var liClass = (s.closet_needs_restock || s.closet_quantity_level === 'empty' || s.closet_quantity_level === 'low') ? ' class="cl-supply-lowstock"' : '';
            html += '<li' + liClass + '>' + line + '</li>';
          });
          html += '</ul></div>';
        });
        html += '</div>';
      }

      // Activity & Instruction as parallel numbered steps
      var actArr = ls.activity || [];
      var insArr = ls.instruction || [];
      var maxSteps = Math.max(actArr.length, insArr.length);
      if (maxSteps > 0) {
        html += '<div class="cl-lesson-section cl-steps-section"><div class="cl-step-table">';
        html += '<div class="cl-step-table-headers"><span class="cl-step-col-label" style="min-width:32px;">Steps</span><span class="cl-step-col-label">Activity</span><span class="cl-step-col-label">Leader notes</span></div>';
        for (var s = 0; s < maxSteps; s++) {
          var aText = actArr[s] || '';
          var iText = insArr[s] || '';
          if (!aText && !iText) continue;
          html += '<div class="cl-step-table-row">';
          html += '<span class="cl-dyn-bullet">' + (s + 1) + '.</span>';
          html += '<div class="cl-step-cell-view">' + escapeAttr(aText) + '</div>';
          html += '<div class="cl-step-cell-view">' + escapeAttr(iText) + '</div>';
          html += '</div>';
        }
        html += '</div></div>';
      }

      if (ls.links && ls.links.length) {
        html += '<div class="cl-lesson-section"><strong>References</strong><ul>';
        ls.links.forEach(function (l) {
          html += '<li><a href="' + escapeAttr(l.url) + '" target="_blank" rel="noopener noreferrer">' + escapeAttr(l.label || l.url) + '</a></li>';
        });
        html += '</ul></div>';
      }
      html += '</div>';
    });
    html += '</div>';

    // Actions
    html += '<div class="cl-detail-actions">';
    html += '<button class="cl-action-btn" id="cl-copy-btn" data-id="' + curr.id + '">Copy &amp; Modify</button>';
    if (canEdit) {
      html += '<button class="cl-action-btn" id="cl-edit-btn" data-id="' + curr.id + '">Edit</button>';
      html += '<button class="cl-action-btn cl-action-del" id="cl-delete-btn" data-id="' + curr.id + '">Delete</button>';
    }
    html += '</div>';

    return html;
  }

  function wireCurriculumEvents() {
    var closeBtn = personDetailCard.querySelector('.detail-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        if (curriculumState.view === 'editor') {
          // Don't discard the autosaved draft here — user may have hit X to
          // get away from the expired-token error. The autosave preserves
          // their work for next time they open the editor.
          if (!confirm('Close the editor? Your draft is auto-saved in this browser and will be offered when you reopen.')) return;
          curriculumState.draft = null;
          curriculumState.editingId = null;
        }
        closeDetail();
      });
    }
    // Backdrop click closes the modal — except in the editor, where it would
    // be too easy to lose unsaved work.
    personDetail.onclick = function (e) {
      if (e.target !== personDetail) return;
      if (curriculumState.view === 'editor') return;
      closeDetail();
    };

    // Library controls
    var searchInput = personDetailCard.querySelector('#cl-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        curriculumState.searchQuery = searchInput.value;
        // Surgical update of grid
        var grid = personDetailCard.querySelector('.cl-grid');
        var count = personDetailCard.querySelector('.cl-count');
        if (!grid) return;
        // Re-render just the grid portion
        var tempContainer = document.createElement('div');
        tempContainer.innerHTML = renderCurriculumLibraryBody();
        var newGrid = tempContainer.querySelector('.cl-grid');
        var newCount = tempContainer.querySelector('.cl-count');
        if (newGrid) grid.innerHTML = newGrid.innerHTML;
        if (newCount && count) count.innerHTML = newCount.innerHTML;
        // Re-wire the cards (buttons) — simple full re-wire for clicks
        wireCurriculumCardClicks();
      });
    }

    var createBtn = personDetailCard.querySelector('#cl-create-btn');
    if (createBtn) {
      createBtn.addEventListener('click', startNewCurriculum);
    }

    // Cards (library view)
    wireCurriculumCardClicks();

    // Detail view
    var backBtn = personDetailCard.querySelector('#cl-back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', showCurriculumLibrary);
    }
    personDetailCard.querySelectorAll('#cl-copy-btn, #cl-copy-btn-top').forEach(function (b) {
      b.addEventListener('click', copyAndEditCurriculum);
    });
    var printBtn = personDetailCard.querySelector('#cl-print-btn');
    if (printBtn) {
      printBtn.addEventListener('click', function () {
        printCurriculumInNewWindow(curriculumState.current);
      });
    }
    personDetailCard.querySelectorAll('#cl-edit-btn, #cl-edit-btn-top').forEach(function (b) {
      b.addEventListener('click', startEditCurriculum);
    });
    personDetailCard.querySelectorAll('#cl-delete-btn, #cl-delete-btn-top').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Delete this plan? This cannot be undone.')) return;
        var id = b.getAttribute('data-id');
        curriculumFetch('/api/curriculum?id=' + encodeURIComponent(id), { method: 'DELETE' }).then(function (res) {
          if (!res.ok) { alert('Error: ' + (res.data.error || 'delete failed')); return; }
          showCurriculumLibrary();
        });
      });
    });
    // Reviewer-only ⭐ favorite toggle. Flips curriculum.is_favorite and
    // updates the button label without reloading the library.
    var favBtn = personDetailCard.querySelector('#cl-fav-btn-top');
    if (favBtn) {
      favBtn.addEventListener('click', function () {
        var id = favBtn.getAttribute('data-id');
        var isFav = favBtn.getAttribute('data-fav') === '1';
        var desired = !isFav;
        favBtn.disabled = true;
        favBtn.textContent = desired ? 'Starring…' : 'Removing star…';
        curriculumFetch('/api/curriculum?action=favorite&id=' + encodeURIComponent(id), {
          method: 'PATCH',
          body: JSON.stringify({ is_favorite: desired })
        }).then(function (res) {
          if (!res.ok) {
            alert('Error: ' + (res.data.error || 'favorite toggle failed'));
            favBtn.disabled = false;
            favBtn.textContent = isFav ? '★ Unfavorite' : '☆ Mark as Favorite';
            return;
          }
          // Mutate the in-memory state so the detail re-renders with the new badge
          if (curriculumState.current) curriculumState.current.is_favorite = desired;
          if (Array.isArray(curriculumState.list)) {
            curriculumState.list.forEach(function (c) {
              if (c.id === parseInt(id, 10)) c.is_favorite = desired;
            });
          }
          renderCurriculumModal();
        });
      });
    }

    // ── Editor view wiring ──
    // Debounced autosave on any input change inside the editor
    if (curriculumState.view === 'editor') {
      var autosaveTimer = null;
      personDetailCard.addEventListener('input', function (e) {
        if (!e.target.matches('input, textarea, select')) return;
        clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(function () {
          gatherEditorDraftFromForm();
          autosaveDraft();
        }, 500);
      });
      // Auto-capitalize supply names on blur (but not while typing)
      personDetailCard.addEventListener('focusout', function (e) {
        if (e.target && e.target.matches('.cl-supply-name')) {
          var newVal = capitalizeFirstLetter(e.target.value);
          if (newVal !== e.target.value) e.target.value = newVal;
        }
      });
    }

    var editorCancel = personDetailCard.querySelector('#cl-editor-cancel');
    if (editorCancel) {
      editorCancel.addEventListener('click', function () {
        if (!confirm('Discard changes?')) return;
        clearDraftAutosave();
        curriculumState.draft = null;
        if (curriculumState.editingId && curriculumState.current) {
          curriculumState.view = 'detail';
        } else {
          curriculumState.editingId = null;
          showCurriculumLibrary();
          return;
        }
        renderCurriculumModal();
      });
    }

    var saveBtn = personDetailCard.querySelector('#cl-editor-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', saveCurriculumDraft);
    }

    // Lesson count change → re-render editor (capturing current inputs first)
    var lcSelect = personDetailCard.querySelector('#cl-f-lesson-count');
    if (lcSelect) {
      lcSelect.addEventListener('change', function () {
        gatherEditorDraftFromForm();
        curriculumState.draft.lesson_count = parseInt(lcSelect.value, 10) || 5;
        renderCurriculumModal();
      });
    }

    // Pre-fill from a class the user is teaching
    var prefillSelect = personDetailCard.querySelector('#cl-prefill-select');
    if (prefillSelect) {
      prefillSelect.addEventListener('change', function () {
        if (!prefillSelect.value) return;
        gatherEditorDraftFromForm();
        var assignments = getMyTeachingAssignments();
        var pick = assignments[parseInt(prefillSelect.value, 10)];
        if (!pick) return;
        // Confirm before overwriting non-empty fields
        var d = curriculumState.draft;
        var hasContent = (d.title || d.overview || d.age_range);
        if (hasContent && !confirm('This will overwrite the title, overview, and age range. Continue?')) {
          prefillSelect.value = '';
          return;
        }
        d.title = pick.name;
        d.overview = pick.description || '';
        var matched = matchAgeRangeOption(pick.ageRange);
        if (matched) d.age_range = matched;
        renderCurriculumModal();
      });
    }

    // Dynamic "Add step / supply / link" buttons
    personDetailCard.querySelectorAll('.cl-dyn-add').forEach(function (btn) {
      btn.addEventListener('click', function () {
        gatherEditorDraftFromForm();
        var field = btn.getAttribute('data-dyn-add');
        var lessonEl = btn.closest('.cl-lesson-edit');
        var idx = parseInt(lessonEl.getAttribute('data-lesson-idx'), 10);
        var lesson = curriculumState.draft.lessons[idx];
        if (field === 'supplies') {
          lesson.supplies.push({ item_name: '', qty: '', qty_unit: '', notes: '', closet_item_id: null });
        } else if (field === 'links') {
          lesson.links.push({ label: '', url: '' });
        } else if (field === 'step-pair') {
          lesson.activity.push('');
          lesson.instruction.push('');
        }
        renderCurriculumModal();
      });
    });

    // Copy supplies from another lesson
    personDetailCard.querySelectorAll('.cl-supply-copy').forEach(function (sel) {
      sel.addEventListener('change', function () {
        if (!sel.value) return;
        gatherEditorDraftFromForm();
        var sourceIdx = parseInt(sel.value, 10);
        var targetIdx = parseInt(sel.getAttribute('data-target-lesson'), 10);
        var source = curriculumState.draft.lessons[sourceIdx];
        var target = curriculumState.draft.lessons[targetIdx];
        if (!source || !target) return;
        // Skip duplicates already in the target (matched by case-insensitive name)
        var existing = {};
        target.supplies.forEach(function (s) { existing[(s.item_name || '').toLowerCase().trim()] = true; });
        var added = 0;
        source.supplies.forEach(function (s) {
          var k = (s.item_name || '').toLowerCase().trim();
          if (!k || existing[k]) return;
          target.supplies.push({
            item_name: s.item_name,
            qty: s.qty,
            qty_unit: s.qty_unit,
            notes: s.notes,
            closet_item_id: s.closet_item_id || null
          });
          existing[k] = true;
          added++;
        });
        sel.value = '';
        renderCurriculumModal();
        if (added === 0) {
          // Brief inline-style feedback if everything was already there
          alert('All of those supplies are already in this lesson.');
        }
      });
    });

    // Dynamic remove buttons
    personDetailCard.querySelectorAll('.cl-dyn-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        gatherEditorDraftFromForm();
        var field = btn.getAttribute('data-dyn-remove');
        var idx = parseInt(btn.getAttribute('data-dyn-idx'), 10);
        var lessonEl = btn.closest('.cl-lesson-edit');
        var lessonIdx = parseInt(lessonEl.getAttribute('data-lesson-idx'), 10);
        var lesson = curriculumState.draft.lessons[lessonIdx];
        if (field === 'supplies') {
          lesson.supplies.splice(idx, 1);
        } else if (field === 'links') {
          lesson.links.splice(idx, 1);
        } else if (field === 'step-pair') {
          lesson.activity.splice(idx, 1);
          lesson.instruction.splice(idx, 1);
          if (lesson.activity.length === 0) {
            lesson.activity.push('');
            lesson.instruction.push('');
          }
        }
        renderCurriculumModal();
      });
    });
  }

  function wireCurriculumCardClicks() {
    personDetailCard.querySelectorAll('.cl-card').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showCurriculumDetail(btn.getAttribute('data-id'));
      });
    });
  }

  var curriculumBtn = document.getElementById('curriculumBtn');
  if (curriculumBtn) {
    curriculumBtn.addEventListener('click', showCurriculumLibrary);
  }

  // ── Member Agreement & Waivers modal ──
  // Fetches waiver.html and extracts the wv-card so the modal content stays
  // in lockstep with the standalone page (single source of truth).
  var waiverHtmlCache = null;
  var waiverStylesInjected = false;
  function injectWaiverStyles(cssText) {
    if (waiverStylesInjected || !cssText) return;
    var tag = document.createElement('style');
    tag.id = 'waiver-modal-styles';
    // Scope the fetched rules inside the modal so they don't leak elsewhere.
    tag.textContent = cssText;
    document.head.appendChild(tag);
    waiverStylesInjected = true;
  }
  function loadWaiverHtml() {
    if (waiverHtmlCache) return Promise.resolve(waiverHtmlCache);
    return fetch('/waiver.html', { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('fetch failed')); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var card = doc.querySelector('.wv-card:not(#wv-sign-card)');
        var styleEl = doc.querySelector('style');
        if (styleEl) injectWaiverStyles(styleEl.textContent);
        waiverHtmlCache = card ? card.innerHTML : null;
        return waiverHtmlCache;
      });
  }

  // Print the waiver via the shared openPrintIframe helper (same pattern as
  // Class Pack and duty-detail). A hidden iframe receives the self-contained
  // print doc and triggers window.print() — no popup blocker surface, no new
  // tab.
  function printWaiverInNewWindow() {
    loadWaiverHtml().then(function (inner) {
      if (!inner) { alert('Waiver content failed to load — try again.'); return; }
      var doc = '<!doctype html><html><head><meta charset="utf-8">' +
        '<title>Member Agreement &amp; Waivers</title>' +
        '<style>' +
          'body { font-family: Georgia, "Times New Roman", serif; color: #222; margin: 0.5in; line-height: 1.45; }' +
          'h1 { font-family: "Playfair Display", Georgia, serif; color: #4a2d3a; font-size: 20pt; margin: 0 0 4pt 0; }' +
          'h2 { font-family: "Playfair Display", Georgia, serif; color: #4a2d3a; font-size: 14pt; margin: 14pt 0 4pt; page-break-after: avoid; }' +
          'h3 { font-size: 11pt; margin: 10pt 0 3pt; page-break-after: avoid; }' +
          'p, li { font-size: 10.5pt; }' +
          'ul, ol { margin: 4pt 0 8pt 18pt; padding: 0; }' +
          '.wv-meta { color: #666; font-size: 9pt; margin: 0 0 12pt 0; }' +
          '.wv-actions, #wv-sign-card { display: none !important; }' +
          '@media print { @page { margin: 0.5in; } }' +
        '</style></head><body>' +
        '<h1>Member Agreement &amp; Waivers</h1>' +
        '<p class="wv-meta">Reference copy of the agreement families accept when registering.</p>' +
        inner +
        '</body></html>';
      openPrintIframe(doc);
    });
  }

  function showWaiverModal() {
    if (!personDetail || !personDetailCard) return;
    // Unified modal header: Print lives next to the close X (same pattern as
    // Class Pack / duty-detail — see `.detail-actions` in styles.css).
    var html = '<div class="detail-actions no-print">';
    html += '<button type="button" class="sc-btn" id="waiverModalPrint" aria-label="Print">\u2399 Print</button>';
    html += '</div>';
    html += '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail wv-modal" id="waiverModalBody">';
    html += '<div style="text-align:center;color:#777;padding:40px 0;">Loading Member Agreement…</div>';
    html += '</div>';
    personDetailCard.innerHTML = html;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.onclick = function (ev) { if (ev.target === personDetail) closeDetail(); };
    var printBtn = document.getElementById('waiverModalPrint');
    if (printBtn) printBtn.addEventListener('click', printWaiverInNewWindow);

    loadWaiverHtml().then(function (inner) {
      var body = document.getElementById('waiverModalBody');
      if (!body) return;
      if (!inner) {
        body.innerHTML = '<p style="color:#b93a33;">Could not load the waiver. <a href="waiver.html" target="_blank" rel="noopener">Open in a new tab instead</a>.</p>';
        return;
      }
      body.innerHTML =
        '<h2 style="font-family:\'Playfair Display\',serif;color:var(--color-primary-dark);margin:0 0 8px;">Member Agreement &amp; Waivers</h2>' +
        '<p style="color:#555;margin:0 0 16px;">Reference copy of the agreement families accept when registering.</p>' +
        '<div id="waiverModalContent">' + inner + '</div>';
      // Suppress the inline "Print / Save as PDF" and "Back to Member Portal"
      // buttons that live inside the fetched wv-card — they don't make sense
      // inside the modal.
      body.querySelectorAll('.wv-actions').forEach(function (el) { el.style.display = 'none'; });
    }).catch(function () {
      var body = document.getElementById('waiverModalBody');
      if (body) body.innerHTML = '<p style="color:#b93a33;">Could not load the waiver. <a href="waiver.html" target="_blank" rel="noopener">Open in a new tab instead</a>.</p>';
    });
  }

  var waiverBtn = document.getElementById('waiverBtn');
  if (waiverBtn) {
    waiverBtn.addEventListener('click', showWaiverModal);
  }

  // Delegated click handler for Resources widget buttons (rendered dynamically
  // inside the Workspace panel, so static IDs don't attach).
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-resource-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-resource-action');
    if (action === 'waiver') showWaiverModal();
    else if (action === 'curriculum' && typeof showCurriculumLibrary === 'function') showCurriculumLibrary();
    else if (action === 'class-ideas' && typeof showClassIdeasPopup === 'function') showClassIdeasPopup();
    else if (action === 'supply-closet' && typeof showSupplyClosetPopup === 'function') showSupplyClosetPopup(true);
    else if (action === 'schedule-builder' && typeof showScheduleBuilder === 'function') showScheduleBuilder();
    else if (action === 'pm-submissions-report' && typeof showPmSubmissionsModal === 'function') showPmSubmissionsModal();
    else if (action === 'submit-pm-class' && typeof showClassSubmissionModal === 'function') showClassSubmissionModal(null);
    else if (action === 'roles-manager' && typeof showRolesManagerModal === 'function') showRolesManagerModal();
    else if (action === 'member-onboarding' && typeof showMemberOnboardingModal === 'function') showMemberOnboardingModal();
    else if (action === 'waivers-pending' && typeof showWaiversReportModal === 'function') showWaiversReportModal();
    else if (action === 'treasurer-pending-payments' && typeof showMembershipReportModal === 'function') {
      // Open the Membership Report and pre-set the payment-status filter
      // to "pending" once the table renders. Filter element id is fixed
      // so this is a simple setTimeout poll.
      showMembershipReportModal();
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        var sel = document.getElementById('ws-mr-status-filter');
        if (sel) { sel.value = 'pending'; sel.dispatchEvent(new Event('change')); clearInterval(t); }
        else if (tries > 40) clearInterval(t); // give up after ~4s
      }, 100);
    }
  });

  // Render all coordination tabs
  function renderCoordinationTabs() {
    renderSessionTab();
    renderCleaningTab();
    renderVolunteersTab();
    renderEventsTab();
  }

  // Render tabs on load
  renderCoordinationTabs();
  if (typeof renderWorkspaceTab === 'function') renderWorkspaceTab();

  // Render on load if already logged in with a non-expired credential.
  if (localStorage.getItem(SESSION_KEY) === 'true' && hasValidStoredCredential()) {
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

  // True when localStorage holds a Google credential whose `exp` claim is
  // still in the future. Used to decide whether to attempt a silent reauth
  // on page load.
  function hasValidStoredCredential() {
    try {
      var cred = localStorage.getItem('rw_google_credential');
      if (!cred) return false;
      var payload = JSON.parse(atob(cred.split('.')[1]));
      if (!payload || !payload.exp) return false;
      return (payload.exp * 1000) > Date.now();
    } catch (e) { return false; }
  }

  function initGoogleSignIn() {
    if (!GOOGLE_CLIENT_ID || typeof google === 'undefined' || !google.accounts) return false;
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleSignIn,
      auto_select: true
    });

    // Attempt silent reauth when we have a stale/missing credential but the
    // user has previously signed in. With auto_select, Google will fire the
    // callback silently if there's a single eligible session.
    if (!hasValidStoredCredential()) {
      try { google.accounts.id.prompt(); } catch (e) { /* ignore */ }
    }

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
      localStorage.setItem(SESSION_KEY, 'true');
      localStorage.setItem('rw_user_name', payload.name || '');
      localStorage.setItem('rw_user_email', email);
      localStorage.setItem('rw_google_credential', response.credential);
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

  // ═══════════════════════════════════════════════════════
  // ABSENCE & COVERAGE SYSTEM (inside IIFE for scope access)
  // ═══════════════════════════════════════════════════════

  window._rw_getCoopDatesInSession = getCoopDatesInSession;
  window._rw_showAbsenceModal = showAbsenceModal;
  window._rw_loadCoverageBoard = loadCoverageBoard;
  window._rw_loadNotifications = loadNotifications;
  window._rw_initAbsenceCoverageSystem = initAbsenceCoverageSystem;
  window._rw_initPushSubscription = initPushSubscription;

  // Returns an array of YYYY-MM-DD strings for every co-op day (Wednesday)
  // within the session window. Named generically so a future day-of-week
  // change is a single-constant edit.
  var COOP_DAY_OF_WEEK = 3; // 0=Sun, 3=Wed
  function getCoopDatesInSession(sessionNumber) {
    var sess = SESSION_DATES[sessionNumber];
    if (!sess) return [];
    var dates = [];
    var d = new Date(sess.start + 'T12:00:00');
    var end = new Date(sess.end + 'T12:00:00');
    while (d.getDay() !== COOP_DAY_OF_WEEK) d.setDate(d.getDate() + 1);
    while (d <= end) {
      dates.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 7);
    }
    return dates;
  }

  function formatDateLabel(isoDate) {
    // Handle both 'YYYY-MM-DD' and full ISO timestamps
    var dateStr = String(isoDate || '').slice(0, 10);
    var d = new Date(dateStr + 'T12:00:00');
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function nameMatchAbsence(a, b) {
    if (!a || !b) return false;
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  function getResponsibilitiesForBlocks(parentFullNames, session, blocks, familyName) {
    var slots = [];
    function has(b) { return blocks.indexOf(b) !== -1; }

    if (has('AM')) {
      Object.keys(AM_CLASSES).forEach(function (groupName) {
        var staff = AM_CLASSES[groupName];
        var sess = staff.sessions[session];
        if (!sess) return;
        parentFullNames.forEach(function (full) {
          if (nameMatchAbsence(sess.teacher, full)) {
            slots.push({ block: 'AM', role_type: 'teacher', role_description: 'Leading ' + groupName + ' (' + staff.ages + ') 10:00\u201312:00 ' + (sess.room || ''), group_or_class: groupName });
          }
          (sess.assistants || []).forEach(function (a) {
            if (nameMatchAbsence(a, full)) {
              slots.push({ block: 'AM', role_type: 'assistant', role_description: 'Assisting ' + groupName + ' (' + staff.ages + ') 10:00\u201312:00 ' + (sess.room || ''), group_or_class: groupName });
            }
          });
        });
      });
      var amSupport = AM_SUPPORT_ROLES[session];
      if (amSupport) {
        ['10-11', '11-12'].forEach(function (slot) {
          if (amSupport.floaters && amSupport.floaters[slot]) {
            amSupport.floaters[slot].forEach(function (name) {
              parentFullNames.forEach(function (full) {
                if (nameMatchAbsence(name, full)) slots.push({ block: 'AM', role_type: 'floater', role_description: 'AM Floater ' + slot, group_or_class: '' });
              });
            });
          }
          if (amSupport.prepPeriod && amSupport.prepPeriod[slot]) {
            amSupport.prepPeriod[slot].forEach(function (name) {
              parentFullNames.forEach(function (full) {
                if (nameMatchAbsence(name, full)) slots.push({ block: 'AM', role_type: 'prep', role_description: 'Prep Period ' + slot, group_or_class: '' });
              });
            });
          }
        });
      }
    }

    if (has('PM1') || has('PM2')) {
      (PM_ELECTIVES[session] || []).forEach(function (elec) {
        var isPM1 = elec.hour === 1 || elec.hour === 'both';
        var isPM2 = elec.hour === 2 || elec.hour === 'both';
        parentFullNames.forEach(function (full) {
          if (nameMatchAbsence(elec.leader, full)) {
            if (isPM1 && has('PM1')) slots.push({ block: 'PM1', role_type: 'teacher', role_description: 'Leading ' + elec.name + ' 1:00\u20131:55', group_or_class: elec.name });
            if (isPM2 && has('PM2')) slots.push({ block: 'PM2', role_type: 'teacher', role_description: 'Leading ' + elec.name + ' 2:00\u20132:55', group_or_class: elec.name });
          }
          (elec.assistants || []).forEach(function (a) {
            if (nameMatchAbsence(a, full)) {
              if (isPM1 && has('PM1')) slots.push({ block: 'PM1', role_type: 'assistant', role_description: 'Assisting ' + elec.name + ' 1:00\u20131:55', group_or_class: elec.name });
              if (isPM2 && has('PM2')) slots.push({ block: 'PM2', role_type: 'assistant', role_description: 'Assisting ' + elec.name + ' 2:00\u20132:55', group_or_class: elec.name });
            }
          });
        });
      });
      var pmSupport = PM_SUPPORT_ROLES[session];
      if (pmSupport) {
        if (pmSupport.floaters) pmSupport.floaters.forEach(function (name) {
          parentFullNames.forEach(function (full) {
            if (nameMatchAbsence(name, full)) { if (has('PM1')) slots.push({ block: 'PM1', role_type: 'floater', role_description: 'PM Floater', group_or_class: '' }); }
          });
        });
        if (pmSupport.supplyCloset) pmSupport.supplyCloset.forEach(function (name) {
          parentFullNames.forEach(function (full) {
            if (nameMatchAbsence(name, full)) { if (has('PM1')) slots.push({ block: 'PM1', role_type: 'supply_closet', role_description: 'Supply Closet', group_or_class: '' }); }
          });
        });
      }
    }

    if (has('Cleaning')) {
      var sessClean = CLEANING_CREW.sessions[session];
      if (sessClean) {
        ['mainFloor', 'upstairs', 'outside'].forEach(function (floor) {
          if (!sessClean[floor]) return;
          Object.keys(sessClean[floor]).forEach(function (area) {
            if (sessClean[floor][area].some(function (n) { return n.toLowerCase() === familyName.toLowerCase(); }))
              slots.push({ block: 'Cleaning', role_type: 'cleaning', role_description: 'Cleaning: ' + area, group_or_class: area });
          });
        });
        if (sessClean.floater && sessClean.floater.some(function (n) { return n.toLowerCase() === familyName.toLowerCase(); }))
          slots.push({ block: 'Cleaning', role_type: 'cleaning', role_description: 'Cleaning Floater', group_or_class: 'Floater' });
      }
    }
    return slots;
  }

  function showAbsenceModal(prefill) {
    // Guard against double-open (e.g., rapid double-click)
    if (document.getElementById('absenceOverlay')) return;

    var email = getActiveEmail();
    if (!email || !FAMILIES) return;
    var me = null;
    for (var i = 0; i < FAMILIES.length; i++) { if (familyMatchesEmail(FAMILIES[i], email)) { me = FAMILIES[i]; break; } }
    if (!me) { alert('Could not find your family record.'); return; }
    var coopDates = getCoopDatesInSession(currentSession);
    if (coopDates.length === 0) { alert('No session dates available.'); return; }

    var parentNames = me.parents.split(' & ').map(function (p) { return p.trim() + ' ' + me.name; });

    // Determine which blocks this person actually has duties in
    var allBlocks = ['AM', 'PM1', 'PM2', 'Cleaning'];
    var allSlots = getResponsibilitiesForBlocks(parentNames, currentSession, allBlocks, me.name);
    var activeBlocks = {};
    allSlots.forEach(function (s) { activeBlocks[s.block] = true; });
    var hasAnyDuties = Object.keys(activeBlocks).length > 0;

    // Prefill (for Edit flow)
    var editingAbsenceId = prefill && prefill.id ? prefill.id : null;
    var prefillPerson = prefill && prefill.absent_person;
    var prefillDate = prefill && prefill.absence_date ? String(prefill.absence_date).slice(0, 10) : null;
    var prefillBlocks = prefill && prefill.blocks && prefill.blocks.length ? prefill.blocks.slice() : null;
    var prefillNotes = prefill && prefill.notes ? String(prefill.notes) : '';

    // If the prefilled date isn't in the current session window, surface it at the top
    if (prefillDate && coopDates.indexOf(prefillDate) === -1) coopDates.unshift(prefillDate);

    var blockLabelsModal = { AM: 'AM (10:00\u201312:00)', PM1: 'PM1 (1:00\u20131:55)', PM2: 'PM2 (2:00\u20132:55)', Cleaning: 'Cleaning' };

    // Which blocks should start checked?
    var activeBlockList = allBlocks.filter(function (b) { return activeBlocks[b]; });
    var initialChecked = prefillBlocks ? prefillBlocks.filter(function (b) { return activeBlocks[b]; }) : activeBlockList.slice();
    var wholeDayChecked = activeBlockList.length > 0 && activeBlockList.every(function (b) { return initialChecked.indexOf(b) !== -1; });

    function escAttr(s) { return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    var html = '<div class="absence-overlay" id="absenceOverlay"><div class="absence-modal">';
    html += '<button class="detail-close absence-close" id="absenceCloseBtn">&times;</button>';
    html += '<h3>' + (editingAbsenceId ? 'Edit Absence' : 'Report an Absence') + '</h3>';
    html += '<div class="absence-field"><label>Who will be out?</label><select class="cl-input" id="absenceWho">';
    parentNames.forEach(function (name) {
      var sel = (prefillPerson && name === prefillPerson) ? ' selected' : '';
      html += '<option value="' + escAttr(name) + '"' + sel + '>' + name + '</option>';
    });
    html += '</select></div>';
    html += '<div class="absence-field"><label>Which day?</label><div class="absence-dates" id="absenceDates">';
    coopDates.forEach(function (d, idx) {
      var isActive = prefillDate ? (d === prefillDate) : (idx === 0);
      html += '<button class="absence-date-btn' + (isActive ? ' active' : '') + '" data-date="' + d + '">' + formatDateLabel(d) + '</button>';
    });
    html += '</div></div>';
    html += '<div class="absence-field"><label>What will you miss?</label><div class="absence-blocks">';
    if (hasAnyDuties) {
      html += '<label class="absence-block-label"><input type="checkbox" id="absenceWholeDay"' + (wholeDayChecked ? ' checked' : '') + '> <strong>Whole Day</strong></label>';
      allBlocks.forEach(function (blk) {
        if (activeBlocks[blk]) {
          var checked = initialChecked.indexOf(blk) !== -1;
          html += '<label class="absence-block-label"><input type="checkbox" class="absence-block-cb" value="' + blk + '"' + (checked ? ' checked' : '') + '> ' + blockLabelsModal[blk] + '</label>';
        }
      });
    } else {
      html += '<em class="absence-no-slots">No session-specific duties on file for either parent \u2014 reporting this absence is informational, no coverage slots will be created.</em>';
      // Still create a hidden checked block so the submit logic has something to send
      html += '<input type="checkbox" class="absence-block-cb" value="AM" checked style="display:none;">';
    }
    html += '</div></div>';
    if (hasAnyDuties) {
      html += '<div class="absence-field"><label>Responsibilities needing coverage:</label><div class="absence-preview" id="absencePreview"></div></div>';
    }
    html += '<div class="absence-field"><label>Notes (optional)</label><input class="cl-input" id="absenceNotes" placeholder="e.g. sick kids, appointment..." value="' + escAttr(prefillNotes) + '"></div>';
    html += '<button class="btn btn-primary absence-submit" id="absenceSubmitBtn">' + (editingAbsenceId ? 'Save Changes' : 'Submit \u2014 I\'m Out') + '</button>';
    html += '</div></div>';
    document.body.insertAdjacentHTML('beforeend', html);

    var overlay = document.getElementById('absenceOverlay');
    var selectedDate = (prefillDate && coopDates.indexOf(prefillDate) !== -1) ? prefillDate : coopDates[0];
    var selectedPerson = (prefillPerson && parentNames.indexOf(prefillPerson) !== -1) ? prefillPerson : parentNames[0];

    function getSelectedBlocks() {
      var blocks = [];
      overlay.querySelectorAll('.absence-block-cb').forEach(function (cb) { if (cb.checked) blocks.push(cb.value); });
      return blocks;
    }
    function updatePreview() {
      var previewEl = document.getElementById('absencePreview');
      if (!previewEl) return;
      var slotsPreview = getResponsibilitiesForBlocks([selectedPerson], currentSession, getSelectedBlocks(), me.name);
      if (slotsPreview.length === 0) { previewEl.innerHTML = '<em class="absence-no-slots">No session-specific responsibilities for these blocks.</em>'; }
      else {
        var ph = '<ul class="absence-slot-list">';
        slotsPreview.forEach(function (s) { ph += '<li><span class="absence-slot-block">' + s.block + '</span> ' + s.role_description + '</li>'; });
        previewEl.innerHTML = ph + '</ul>';
      }
    }

    document.getElementById('absenceCloseBtn').addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    overlay.querySelectorAll('.absence-date-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        overlay.querySelectorAll('.absence-date-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        selectedDate = btn.getAttribute('data-date');
      });
    });
    document.getElementById('absenceWho').addEventListener('change', function () { selectedPerson = this.value; updatePreview(); });
    var wholeDayCb = document.getElementById('absenceWholeDay');
    if (wholeDayCb) {
      wholeDayCb.addEventListener('change', function () {
        overlay.querySelectorAll('.absence-block-cb').forEach(function (cb) { cb.checked = wholeDayCb.checked; });
        updatePreview();
      });
    }
    overlay.querySelectorAll('.absence-block-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        if (wholeDayCb) {
          var allChecked = true;
          overlay.querySelectorAll('.absence-block-cb').forEach(function (c) { if (!c.checked) allChecked = false; });
          wholeDayCb.checked = allChecked;
        }
        updatePreview();
      });
    });
    document.getElementById('absenceSubmitBtn').addEventListener('click', function () {
      var submitBtn = document.getElementById('absenceSubmitBtn');
      if (submitBtn.disabled) return;
      var blocks = getSelectedBlocks();
      if (blocks.length === 0) { alert('Please select at least one block.'); return; }
      var slotsToSend = getResponsibilitiesForBlocks([selectedPerson], currentSession, blocks, me.name);
      submitBtn.disabled = true; submitBtn.textContent = 'Submitting\u2026';
      var cred = localStorage.getItem('rw_google_credential');
      var notesVal = (document.getElementById('absenceNotes') || {}).value || '';
      var originalLabel = editingAbsenceId ? 'Save Changes' : 'Submit \u2014 I\'m Out';

      function doPost() {
        return fetch('/api/absences', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
          body: JSON.stringify({ absent_person: selectedPerson, family_email: me.email, family_name: me.name, session_number: currentSession, absence_date: selectedDate, blocks: blocks, slots: slotsToSend, notes: notesVal })
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
      }

      var chain;
      if (editingAbsenceId) {
        chain = fetch('/api/absences?id=' + encodeURIComponent(editingAbsenceId), {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + cred }
        }).then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function () { return doPost(); });
      } else {
        chain = doPost();
      }

      chain.then(function (res) {
        if (!res.ok) {
          if (res.status === 409) {
            alert('An absence for ' + selectedPerson + ' on ' + formatDateLabel(selectedDate) + ' already exists. Please cancel the existing one first, then try again.');
          } else {
            alert('Error: ' + ((res.data && res.data.error) || 'Could not submit absence'));
          }
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
          return;
        }
        overlay.remove();
        showSupplyToast(editingAbsenceId ? 'Absence updated' : 'Absence reported \u2014 coverage posted');
        loadCoverageBoard();
        loadNotifications();
      }).catch(function (err) {
        alert('Network error: ' + ((err && err.message) || 'could not submit absence'));
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      });
    });
    updatePreview();
  }

  function loadCoverageBoard() {
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/absences?session=' + currentSession, { headers: { 'Authorization': 'Bearer ' + cred } })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var raw = data.absences || [];
      var filtered = raw.filter(function (a) { return !a.cancelled_at; });
      // Publish first so renderMyFamily can inject any coverage assignments
      // into the user's My Responsibilities card. renderMyFamily() then calls
      // renderCoverageBoard(loadedAbsences) at the end, which repopulates the
      // coverage card — avoiding a separate second render here.
      loadedAbsences = filtered;
      if (typeof renderMyFamily === 'function') renderMyFamily();
      else renderCoverageBoard(filtered);
    })
    .catch(function (err) { console.error('Coverage fetch failed:', err); var el = document.getElementById('coverageBoardContent'); if (el) el.innerHTML = '<p>Could not load coverage data.</p>'; });
  }

  // Store loaded absences so responsibilities card can reference them
  var loadedAbsences = [];

  function renderCoverageBoard(absences) {
    loadedAbsences = absences;
    // Re-render the directory so absence/coverage badges appear on person
    // cards — wrapped in try/catch so a rendering issue here can never block
    // the coverage card itself from showing up.
    try {
      if (typeof renderDirectory === 'function') renderDirectory();
    } catch (e) { console.error('renderDirectory failed inside renderCoverageBoard:', e); }
    var el = document.getElementById('coverageBoardContent');
    var card = document.getElementById('coverageBoardCard');
    if (!el) return;

    var isVpUser = isVP();

    // Non-VP users: hide the card entirely when there's nothing to show.
    // VP always sees it (empty state below) because they're responsible for
    // making sure every position is filled.
    if (absences.length === 0) {
      if (isVpUser) {
        if (card) card.style.display = '';
        var summaryBadge0 = document.getElementById('coverageSummaryBadge');
        if (summaryBadge0) {
          summaryBadge0.textContent = 'All clear';
          summaryBadge0.className = 'coverage-summary-badge coverage-summary-ok';
        }
        el.innerHTML = '<div class="coverage-empty">No absences reported for this session. You\u2019ll see coverage here as soon as someone reports one.</div>';
      } else {
        if (card) card.style.display = 'none';
      }
      updateCoverageNotes();
      renderMyAbsences();
      return;
    }
    if (card) card.style.display = '';

    // Count total open slots for the summary badge
    var totalOpenAll = 0;
    absences.forEach(function (a) { (a.slots || []).forEach(function (s) { if (!s.claimed_by_email) totalOpenAll++; }); });
    var summaryBadge = document.getElementById('coverageSummaryBadge');
    if (summaryBadge) {
      summaryBadge.textContent = totalOpenAll > 0 ? totalOpenAll + ' open' : 'All covered';
      summaryBadge.className = 'coverage-summary-badge ' + (totalOpenAll > 0 ? 'coverage-summary-open' : 'coverage-summary-ok');
    }

    var email = getActiveEmail();
    var me = null;
    for (var i = 0; i < FAMILIES.length; i++) { if (familyMatchesEmail(FAMILIES[i], email)) { me = FAMILIES[i]; break; } }
    var myName = me ? me.parents.split(' & ')[0].trim() + ' ' + me.name : '';

    // Group absences by date
    var byDate = {};
    absences.forEach(function (a) {
      var dateKey = String(a.absence_date || '').slice(0, 10);
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push(a);
    });

    // Drive the tab list off the actual absence dates we have, not off the
    // Wednesday-only session calendar. This is defensive: it means any legacy
    // absences (e.g. the Tuesday dates from before the co-op day fix) still
    // render instead of silently being filtered into oblivion.
    var activeDates = Object.keys(byDate).sort();
    if (activeDates.length === 0) {
      if (isVpUser) {
        el.innerHTML = '<div class="coverage-empty">No absences reported for any upcoming co-op day this session.</div>';
      } else if (card) {
        card.style.display = 'none';
      }
      return;
    }

    // Find default tab — first date with open slots
    var defaultDate = activeDates[0];
    for (var i = 0; i < activeDates.length; i++) {
      var hasOpen = false;
      (byDate[activeDates[i]] || []).forEach(function (a) { (a.slots || []).forEach(function (s) { if (!s.claimed_by_email) hasOpen = true; }); });
      if (hasOpen) { defaultDate = activeDates[i]; break; }
    }

    // Build tabs
    var html = '<div class="portal-tab-nav coverage-tab-nav">';
    activeDates.forEach(function (date) {
      var openCount = 0;
      (byDate[date] || []).forEach(function (a) { (a.slots || []).forEach(function (s) { if (!s.claimed_by_email) openCount++; }); });
      var isActive = date === defaultDate;
      var shortLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      html += '<button class="portal-tab coverage-tab' + (isActive ? ' active' : '') + '" data-cov-date="' + date + '">';
      html += shortLabel;
      if (openCount > 0) html += ' <span class="coverage-tab-badge">' + openCount + '</span>';
      html += '</button>';
    });
    html += '</div>';

    // Build panels — primary view shows both open ("Needs Coverage") and
    // filled slots ("Covered"); detail view keeps the per-person breakdown.
    activeDates.forEach(function (date) {
      var dateAbsences = byDate[date] || [];
      var isActive = date === defaultDate;

      // Collect open and covered slots
      var openSlots = [];
      var coveredSlots = [];
      var allSlotsByPerson = [];
      dateAbsences.forEach(function (a) {
        var personSlots = { person: a.absent_person, notes: a.notes, slots: [] };
        (a.slots || []).forEach(function (slot) {
          slot._person = a.absent_person;
          slot._familyEmail = a.family_email;
          if (slot.claimed_by_email) coveredSlots.push(slot);
          else openSlots.push(slot);
          personSlots.slots.push(slot);
        });
        allSlotsByPerson.push(personSlots);
      });

      html += '<div class="coverage-panel' + (isActive ? ' active' : '') + '" data-cov-panel="' + date + '">';

      // ── Primary: open slots needing coverage ──
      if (openSlots.length > 0) {
        html += '<div class="coverage-open-section">';
        html += '<div class="coverage-section-label">Needs Coverage</div>';
        openSlots.forEach(function (slot) {
          var isMyOwnAbsence = slot._familyEmail && slot._familyEmail === email;
          html += '<div class="coverage-slot coverage-slot-open">';
          html += '<span class="coverage-slot-block">' + slot.block + '</span>';
          html += '<span class="coverage-slot-desc">' + slot.role_description + ' <span class="coverage-slot-for">(' + slot._person + ')</span></span>';
          html += '<span class="coverage-slot-actions">';
          if (!isMyOwnAbsence) {
            html += '<button class="btn btn-sm btn-cover" data-slot-id="' + slot.id + '">I\'ll Cover This</button>';
          }
          if (isVpUser) html += '<button class="btn btn-sm btn-outline btn-assign" data-slot-id="' + slot.id + '" data-slot-desc="' + (slot.role_description || '').replace(/"/g, '&quot;') + '" data-slot-date="' + date + '">Assign\u2026</button>';
          html += '</span>';
          html += '</div>';
        });
        html += '</div>';
      } else {
        html += '<div class="coverage-all-covered">All slots covered for this day!</div>';
      }

      // ── Primary: who is covering whose role (always visible) ──
      if (coveredSlots.length > 0) {
        html += '<div class="coverage-covered-section">';
        html += '<div class="coverage-section-label coverage-section-label-ok">Covered</div>';
        coveredSlots.forEach(function (slot) {
          var isMyClaim = slot.claimed_by_email && slot.claimed_by_email === email;
          html += '<div class="coverage-slot coverage-slot-covered">';
          html += '<span class="coverage-slot-block">' + slot.block + '</span>';
          html += '<span class="coverage-slot-desc">' + slot.role_description + ' <span class="coverage-slot-for">(' + slot._person + ')</span></span>';
          html += '<span class="coverage-slot-claimer">Covered by <strong>' + (slot.claimed_by_name || slot.claimed_by_email) + '</strong></span>';
          if (isVpUser || isMyClaim) {
            html += '<span class="coverage-slot-actions">';
            if (isVpUser) {
              html += '<button class="btn btn-sm btn-outline btn-reassign" data-slot-id="' + slot.id + '" data-slot-desc="' + (slot.role_description || '').replace(/"/g, '&quot;') + '" data-slot-date="' + date + '">Reassign</button>';
              html += '<button class="btn btn-sm btn-link btn-unassign" data-slot-id="' + slot.id + '" title="Remove coverage">Unassign</button>';
            } else if (isMyClaim) {
              html += '<button class="sc-btn sc-btn-del btn-cancel-cover" data-slot-id="' + slot.id + '" title="Cancel covering this slot">Cancel</button>';
            }
            html += '</span>';
          }
          html += '</div>';
        });
        html += '</div>';
      }

      // ── Secondary: full detail (collapsed by default) ──
      html += '<details class="coverage-details">';
      html += '<summary class="coverage-details-toggle">See all absences &amp; coverage (' + dateAbsences.length + ' out)</summary>';
      allSlotsByPerson.forEach(function (p) {
        html += '<div class="coverage-absence"><div class="coverage-person"><strong>' + p.person + '</strong> <span class="coverage-person-note">is out' + (p.notes ? ' \u2014 ' + p.notes : '') + '</span></div>';
        p.slots.forEach(function (slot) {
          var isClaimed = !!slot.claimed_by_email;
          html += '<div class="coverage-slot ' + (isClaimed ? 'coverage-slot-covered' : 'coverage-slot-open') + '">';
          html += '<span class="coverage-slot-block">' + slot.block + '</span><span class="coverage-slot-desc">' + slot.role_description + '</span>';
          html += isClaimed ? '<span class="coverage-slot-claimer">Covered by ' + (slot.claimed_by_name || slot.claimed_by_email) + '</span>' : '<span class="coverage-slot-uncovered">Uncovered</span>';
          html += '</div>';
        });
        html += '</div>';
      });
      html += '</details>';
      html += '</div>';
    });

    el.innerHTML = html;

    // Wire tabs
    el.querySelectorAll('.coverage-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var date = tab.getAttribute('data-cov-date');
        el.querySelectorAll('.coverage-tab').forEach(function (t) { t.classList.remove('active'); });
        el.querySelectorAll('.coverage-panel').forEach(function (p) { p.classList.remove('active'); });
        tab.classList.add('active');
        var panel = el.querySelector('[data-cov-panel="' + date + '"]');
        if (panel) panel.classList.add('active');
      });
    });

    // Wire claim buttons
    el.querySelectorAll('.btn-cover').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slotId = parseInt(btn.getAttribute('data-slot-id'), 10);
        btn.disabled = true; btn.textContent = 'Claiming\u2026';
        var cred = localStorage.getItem('rw_google_credential');
        fetch('/api/coverage', { method: 'POST', headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' }, body: JSON.stringify({ slot_id: slotId, claimer_name: myName }) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) { if (!res.ok) { alert('Error: ' + (res.data.error || 'claim failed')); btn.disabled = false; btn.textContent = 'I\'ll Cover This'; return; } loadCoverageBoard(); loadNotifications(); });
      });
    });

    // Wire VP assign/reassign buttons
    el.querySelectorAll('.btn-assign, .btn-reassign').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showAssignCoverageModal({
          slotId: parseInt(btn.getAttribute('data-slot-id'), 10),
          slotDesc: btn.getAttribute('data-slot-desc') || '',
          slotDate: btn.getAttribute('data-slot-date') || ''
        });
      });
    });

    // Wire self-cancel buttons (claimer cancels their own coverage)
    el.querySelectorAll('.btn-cancel-cover').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('Cancel your coverage for this slot? It will go back to Needs Coverage.')) return;
        var slotId = parseInt(btn.getAttribute('data-slot-id'), 10);
        btn.disabled = true; btn.textContent = 'Cancelling\u2026';
        var cred = localStorage.getItem('rw_google_credential');
        fetch('/api/coverage?id=' + slotId, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + cred }
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (!res.ok) { alert('Error: ' + (res.data.error || 'cancel failed')); btn.disabled = false; btn.textContent = 'Cancel'; return; }
          loadCoverageBoard();
          loadNotifications();
        });
      });
    });

    // Wire VP unassign buttons
    el.querySelectorAll('.btn-unassign').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('Remove this coverage assignment?')) return;
        var slotId = parseInt(btn.getAttribute('data-slot-id'), 10);
        btn.disabled = true;
        var cred = localStorage.getItem('rw_google_credential');
        fetch('/api/coverage?id=' + slotId, {
          method: 'PATCH',
          headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
          body: JSON.stringify({ claimed_by_email: '', claimed_by_name: '' })
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (!res.ok) { alert('Error: ' + (res.data.error || 'unassign failed')); btn.disabled = false; return; }
          loadCoverageBoard();
        });
      });
    });

    // Update responsibility coverage notes and my absences
    updateCoverageNotes();
    renderMyAbsences();
  }

  // ── VP: assign/reassign a coverage slot to any family ────────────────────
  function showAssignCoverageModal(opts) {
    if (document.getElementById('assignCoverageOverlay')) return;
    var slotId = opts.slotId;
    var slotDesc = opts.slotDesc || 'this slot';
    var dateLabel = opts.slotDate ? formatDateLabel(opts.slotDate) : '';

    // Flat list of parents across all families, sorted by family name.
    // buildParentPickerOptions derives a per-parent Workspace email; the
    // coverage flow only stamps a display name + email on the slot, so
    // the per-parent email is a tighter audit trail than the shared
    // family email this modal used to send.
    var people = buildParentPickerOptions();

    var html = '<div class="absence-overlay" id="assignCoverageOverlay"><div class="absence-modal">';
    html += '<button class="detail-close absence-close" id="assignCoverageCloseBtn" aria-label="Close">&times;</button>';
    html += '<h3>Assign Coverage</h3>';
    html += '<p class="assign-coverage-slot"><strong>' + slotDesc + '</strong>' + (dateLabel ? ' \u00b7 ' + dateLabel : '') + '</p>';
    html += '<div class="absence-field"><label>Who will cover this?</label>';
    html += '<select class="cl-input" id="assignCoveragePerson">';
    html += '<option value="">\u2014 Pick a person \u2014</option>';
    people.forEach(function (p) {
      html += '<option value="' + p.email + '|' + p.displayName.replace(/\|/g, '') + '">' + p.displayName + '</option>';
    });
    html += '</select></div>';
    html += '<button class="btn btn-primary absence-submit" id="assignCoverageSubmitBtn">Assign</button>';
    html += '</div></div>';
    document.body.insertAdjacentHTML('beforeend', html);

    var overlay = document.getElementById('assignCoverageOverlay');
    function close() { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    document.getElementById('assignCoverageCloseBtn').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    document.getElementById('assignCoverageSubmitBtn').addEventListener('click', function () {
      var sel = document.getElementById('assignCoveragePerson');
      var val = sel ? sel.value : '';
      if (!val) { alert('Please pick a person.'); return; }
      var pipeIdx = val.indexOf('|');
      var assigneeEmail = val.slice(0, pipeIdx);
      var assigneeName = val.slice(pipeIdx + 1);
      var btn = document.getElementById('assignCoverageSubmitBtn');
      btn.disabled = true; btn.textContent = 'Assigning\u2026';
      var cred = localStorage.getItem('rw_google_credential');
      fetch('/api/coverage?id=' + slotId, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimed_by_email: assigneeEmail, claimed_by_name: assigneeName })
      })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          alert('Error: ' + (res.data.error || 'assign failed'));
          btn.disabled = false; btn.textContent = 'Assign';
          return;
        }
        close();
        loadCoverageBoard();
      });
    });
  }

  // Add coverage notes to the responsibilities card
  // If someone in your class/elective is out, show who's covering
  function updateCoverageNotes() {
    if (!loadedAbsences || loadedAbsences.length === 0) return;
    var notesContainer = document.getElementById('coverageNotesArea');
    if (!notesContainer) return;

    var email = getActiveEmail();
    var me = null;
    for (var i = 0; i < FAMILIES.length; i++) { if (familyMatchesEmail(FAMILIES[i], email)) { me = FAMILIES[i]; break; } }
    if (!me) return;
    var parentFullNames = me.parents.split(' & ').map(function (p) { return p.trim() + ' ' + me.name; });

    // Find which classes/electives I teach or assist
    var myClasses = []; // { groupName, role }
    Object.keys(AM_CLASSES).forEach(function (groupName) {
      var sess = (AM_CLASSES[groupName].sessions || {})[currentSession];
      if (!sess) return;
      parentFullNames.forEach(function (full) {
        if (nameMatchAbsence(sess.teacher, full) || (sess.assistants || []).some(function (a) { return nameMatchAbsence(a, full); })) {
          myClasses.push(groupName);
        }
      });
    });
    var myElectives = [];
    (PM_ELECTIVES[currentSession] || []).forEach(function (elec) {
      parentFullNames.forEach(function (full) {
        if (nameMatchAbsence(elec.leader, full) || (elec.assistants || []).some(function (a) { return nameMatchAbsence(a, full); })) {
          myElectives.push(elec.name);
        }
      });
    });

    if (myClasses.length === 0 && myElectives.length === 0) { notesContainer.innerHTML = ''; return; }

    // Check if any absent person has a slot matching my classes/electives.
    // Skip absences where I'm the one out — those are already surfaced in
    // "Your Upcoming Absences" below, with per-slot coverage status.
    var notes = [];
    loadedAbsences.forEach(function (a) {
      if (a.family_email === email) return;
      (a.slots || []).forEach(function (slot) {
        var match = false;
        if (myClasses.indexOf(slot.group_or_class) !== -1) match = true;
        if (myElectives.indexOf(slot.group_or_class) !== -1) match = true;
        if (!match) return;
        var dateLabel = formatDateLabel(a.absence_date);
        if (slot.claimed_by_email) {
          notes.push('<span class="cov-note cov-note-ok">' + dateLabel + ': ' + a.absent_person + ' is out from ' + slot.group_or_class + ' \u2014 covered by <strong>' + (slot.claimed_by_name || slot.claimed_by_email) + '</strong></span>');
        } else {
          notes.push('<span class="cov-note cov-note-open">' + dateLabel + ': ' + a.absent_person + ' is out from ' + slot.group_or_class + ' \u2014 <strong>needs coverage</strong></span>');
        }
      });
    });

    notesContainer.innerHTML = notes.length > 0 ? notes.join('') : '';
  }

  // Show the current user's own absences with edit/cancel options
  function renderMyAbsences() {
    var el = document.getElementById('myAbsencesArea');
    if (!el || !loadedAbsences || loadedAbsences.length === 0) { if (el) el.innerHTML = ''; return; }

    var email = getActiveEmail();
    if (!email) return;

    var myAbsences = loadedAbsences.filter(function (a) {
      return a.family_email === email && !a.cancelled_at;
    });
    if (myAbsences.length === 0) { el.innerHTML = ''; return; }

    var html = '<div class="my-absences"><div class="mf-block-label" style="margin-top:0.75rem;">Your Upcoming Absences</div>';
    myAbsences.forEach(function (a) {
      var dateLabel = formatDateLabel(a.absence_date);
      var blocks = (a.blocks || []).join(', ');
      var coveredCount = 0;
      var totalSlots = (a.slots || []).length;
      (a.slots || []).forEach(function (s) { if (s.claimed_by_email) coveredCount++; });
      var statusText = totalSlots === 0 ? '' : coveredCount === totalSlots ? ' \u2014 all covered' : ' \u2014 ' + (totalSlots - coveredCount) + ' slot' + ((totalSlots - coveredCount) === 1 ? '' : 's') + ' open';

      html += '<div class="my-absence-row">';
      html += '<div class="my-absence-info">';
      html += '<strong>' + dateLabel + '</strong> \u00b7 ' + a.absent_person;
      html += '<div class="my-absence-detail">' + blocks + statusText + '</div>';
      html += '</div>';
      html += '<div class="my-absence-actions">';
      html += '<button class="sc-btn my-absence-edit" data-absence-id="' + a.id + '">Edit</button>';
      html += '<button class="sc-btn sc-btn-del my-absence-cancel" data-absence-id="' + a.id + '">Cancel</button>';
      html += '</div>';
      // Per-slot coverage status so the user sees who's covering each role.
      // Rendered as a direct child of .my-absence-row so it spans the full
      // card width on its own grid row (below info + actions).
      if (totalSlots > 0) {
        html += '<ul class="my-absence-slots">';
        (a.slots || []).forEach(function (s) {
          var label = (s.role_description || s.group_or_class || 'Slot') + ' (' + s.block + ')';
          if (s.claimed_by_email) {
            html += '<li class="my-absence-slot my-absence-slot-ok">' + label + ' \u2014 covered by <strong>' + (s.claimed_by_name || s.claimed_by_email) + '</strong></li>';
          } else {
            html += '<li class="my-absence-slot my-absence-slot-open">' + label + ' \u2014 <strong>needs coverage</strong></li>';
          }
        });
        html += '</ul>';
      }
      html += '</div>';
    });
    html += '</div>';
    el.innerHTML = html;

    // Wire cancel buttons
    el.querySelectorAll('.my-absence-cancel').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-absence-id');
        var absence = null;
        for (var i = 0; i < loadedAbsences.length; i++) {
          if (String(loadedAbsences[i].id) === id) { absence = loadedAbsences[i]; break; }
        }
        var claimedCount = 0;
        if (absence && absence.slots) absence.slots.forEach(function (s) { if (s.claimed_by_email) claimedCount++; });
        var msg = claimedCount > 0
          ? 'Cancel this absence? ' + claimedCount + ' slot' + (claimedCount === 1 ? ' has' : 's have') + ' already been claimed \u2014 those volunteers will be unassigned.'
          : 'Cancel this absence? Coverage slots will be removed.';
        if (!confirm(msg)) return;
        btn.disabled = true; btn.textContent = 'Cancelling\u2026';
        var cred = localStorage.getItem('rw_google_credential');
        fetch('/api/absences?id=' + encodeURIComponent(id), {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + cred }
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (res.error) { alert('Error: ' + res.error); btn.disabled = false; btn.textContent = 'Cancel'; return; }
          showSupplyToast('Absence cancelled');
          loadCoverageBoard();
          loadNotifications();
        }).catch(function (err) {
          alert('Network error: ' + ((err && err.message) || 'could not cancel'));
          btn.disabled = false; btn.textContent = 'Cancel';
        });
      });
    });

    // Wire edit buttons — open modal prefilled; old absence is replaced on submit
    el.querySelectorAll('.my-absence-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-absence-id');
        var absence = null;
        for (var i = 0; i < loadedAbsences.length; i++) {
          if (String(loadedAbsences[i].id) === id) { absence = loadedAbsences[i]; break; }
        }
        if (!absence) return;
        var claimedCount = 0;
        (absence.slots || []).forEach(function (s) { if (s.claimed_by_email) claimedCount++; });
        if (claimedCount > 0) {
          if (!confirm('Heads up: ' + claimedCount + ' slot' + (claimedCount === 1 ? ' has' : 's have') + ' already been claimed for this absence. Saving changes will replace this absence entirely and those volunteers will be unassigned. Continue?')) return;
        }
        showAbsenceModal({
          id: absence.id,
          absent_person: absence.absent_person,
          absence_date: absence.absence_date,
          blocks: absence.blocks,
          notes: absence.notes
        });
      });
    });
  }

  var notifState = { notifications: [], unreadCount: 0, dropdownOpen: false };

  // When communications@ is logged in AND has a View As set, the server
  // reads that user's notification inbox instead of comms@'s own. This lets
  // the super user triage on behalf of whoever they're helping.
  function notifViewAsSuffix() {
    var realEmail = localStorage.getItem('rw_user_email');
    if (realEmail !== COMMS_EMAIL) return '';
    var viewAs = sessionStorage.getItem(VIEW_AS_KEY);
    if (!viewAs) return '';
    return '&view_as=' + encodeURIComponent(viewAs);
  }

  function loadNotifications() {
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/notifications?limit=20' + notifViewAsSuffix(), { headers: { 'Authorization': 'Bearer ' + cred } })
    .then(function (r) { return r.json(); })
    .then(function (data) { notifState.notifications = data.notifications || []; notifState.unreadCount = data.unread_count || 0; updateNotifBadge(); if (notifState.dropdownOpen) renderNotifDropdown(); })
    .catch(function () {});
  }

  function updateNotifBadge() {
    var has = notifState.unreadCount > 0;
    document.querySelectorAll('.notif-badge').forEach(function (badge) {
      if (has) { badge.textContent = notifState.unreadCount > 99 ? '99+' : notifState.unreadCount; badge.style.display = ''; }
      else { badge.style.display = 'none'; }
    });
    // Toggle an "unread" class on every bell button so CSS can pulse/glow it.
    document.querySelectorAll('.notif-bell-btn').forEach(function (btn) {
      btn.classList.toggle('has-unread', has);
    });
  }

  function renderNotifDropdown() {
    var existing = document.getElementById('notifDropdown');
    if (existing) existing.remove();
    // Pick the visible bell. On mobile the desktop #notifBellBtn lives inside
    // a display:none container (.nav-quick-icons), so anchoring the dropdown
    // there would hide it too — tap the mobile bell and nothing appears.
    // offsetParent is null when an ancestor is display:none.
    var bells = document.querySelectorAll('.notif-bell-btn');
    var bell = null;
    for (var bi = 0; bi < bells.length; bi++) {
      if (bells[bi].offsetParent !== null) { bell = bells[bi]; break; }
    }
    if (!bell) bell = document.getElementById('notifBellBtn');
    if (!bell) return;
    var html = '<div class="notif-dropdown" id="notifDropdown"><div class="notif-dropdown-header"><strong>Notifications</strong>';
    if (notifState.unreadCount > 0) html += '<button class="notif-mark-all" id="notifMarkAllBtn">Mark all read</button>';
    html += '</div>';
    if (notifState.notifications.length === 0) { html += '<div class="notif-empty">No notifications yet.</div>'; }
    else { notifState.notifications.forEach(function (n) { html += '<div class="notif-item' + (n.is_read ? '' : ' notif-unread') + '" data-notif-id="' + n.id + '"><div class="notif-item-title">' + n.title + '</div><div class="notif-item-body">' + n.body + '</div><div class="notif-item-time">' + timeAgo(n.created_at) + '</div></div>'; }); }
    html += '</div>';
    bell.insertAdjacentHTML('afterend', html);
    var dropdown = document.getElementById('notifDropdown');
    var markAllBtn = document.getElementById('notifMarkAllBtn');
    if (markAllBtn) { markAllBtn.addEventListener('click', function (e) { e.stopPropagation(); var cred = localStorage.getItem('rw_google_credential'); fetch('/api/notifications?mark_all_read=true' + notifViewAsSuffix(), { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' } }).then(function () { loadNotifications(); }); }); }
    dropdown.querySelectorAll('.notif-item').forEach(function (item) { item.addEventListener('click', function () { var id = item.getAttribute('data-notif-id'); var cred = localStorage.getItem('rw_google_credential'); fetch('/api/notifications?id=' + id + notifViewAsSuffix(), { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' } }).then(function () { loadNotifications(); }); var cov = document.getElementById('coverage'); if (cov) cov.scrollIntoView({ behavior: 'smooth' }); closeNotifDropdown(); }); });
    setTimeout(function () { document.addEventListener('click', closeNotifOnOutsideClick); }, 10);
  }

  function closeNotifOnOutsideClick(e) {
    var dropdown = document.getElementById('notifDropdown');
    if (!dropdown) return;
    // Either bell counts as "inside" — otherwise tapping the mobile bell to
    // toggle it closed would fall through as an outside click.
    var bells = document.querySelectorAll('.notif-bell-btn');
    for (var bi = 0; bi < bells.length; bi++) {
      if (bells[bi].contains(e.target)) return;
    }
    if (!dropdown.contains(e.target)) closeNotifDropdown();
  }
  function closeNotifDropdown() { var dropdown = document.getElementById('notifDropdown'); if (dropdown) dropdown.remove(); notifState.dropdownOpen = false; document.removeEventListener('click', closeNotifOnOutsideClick); }
  function timeAgo(isoStr) { var diff = (Date.now() - new Date(isoStr).getTime()) / 1000; if (diff < 60) return 'just now'; if (diff < 3600) return Math.floor(diff / 60) + 'm ago'; if (diff < 86400) return Math.floor(diff / 3600) + 'h ago'; return Math.floor(diff / 86400) + 'd ago'; }

  function initPushSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    var banner = document.getElementById('pushBanner');
    var enableBtn = document.getElementById('pushBannerEnableBtn');
    var dismissBtn = document.getElementById('pushBannerDismiss');
    if (!banner || !enableBtn) return;
    if (localStorage.getItem('rw_push_dismissed')) return;
    function showBanner() { banner.style.display = ''; var dash = document.getElementById('dashboard'); if (dash) dash.classList.add('has-push-banner'); }
    function hideBanner() { banner.style.display = 'none'; var dash = document.getElementById('dashboard'); if (dash) dash.classList.remove('has-push-banner'); }
    navigator.serviceWorker.register('/sw.js').then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) { if (sub) return; showBanner(); }).catch(function () { showBanner(); });
    if (dismissBtn) { dismissBtn.addEventListener('click', function () { hideBanner(); localStorage.setItem('rw_push_dismissed', '1'); }); }
    enableBtn.addEventListener('click', function () {
      enableBtn.disabled = true; enableBtn.textContent = 'Enabling\u2026';
      navigator.serviceWorker.register('/sw.js').then(function (reg) { return reg.pushManager.getSubscription().then(function (existing) { if (existing) return existing; var vapidKey = document.querySelector('meta[name="vapid-public-key"]'); if (!vapidKey) throw new Error('VAPID key not found'); return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey.content) }); }); })
      .then(function (sub) { var cred = localStorage.getItem('rw_google_credential'); var subJson = sub.toJSON(); return fetch('/api/push-subscribe', { method: 'POST', headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys }) }); })
      .then(function (r) { if (!r.ok) throw new Error('Subscribe failed'); banner.innerHTML = '<div class="container push-banner-inner" style="justify-content:center;color:var(--color-primary);"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> <strong>Notifications enabled!</strong></div>'; setTimeout(function () { hideBanner(); }, 3000); })
      .catch(function (err) { console.error('Push subscription error:', err); enableBtn.disabled = false; enableBtn.textContent = 'Enable'; if (Notification.permission === 'denied') alert('Notifications are blocked. Please enable them in your browser settings.'); });
    });
  }

  function urlBase64ToUint8Array(base64String) { var padding = '='.repeat((4 - base64String.length % 4) % 4); var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/'); var rawData = atob(base64); var out = new Uint8Array(rawData.length); for (var i = 0; i < rawData.length; ++i) out[i] = rawData.charCodeAt(i); return out; }

  // ── Class-Curriculum Links ──
  var classLinks = {}; // class_key → { id, curriculum_id, curriculum_title, ... }

  function loadClassLinks() {
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/curriculum?action=links&session=' + currentSession, { headers: { 'Authorization': 'Bearer ' + cred } })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      classLinks = {};
      (data.links || []).forEach(function (link) {
        classLinks[link.class_key] = link;
      });
      // Re-render responsibilities to show attach/view buttons
      updateClassLinkButtons();
    })
    .catch(function () {});
  }

  function getClassKey(duty) {
    if (!duty || !duty.popup) return null;
    if (duty.popup.type === 'amClass') return duty.popup.group;
    if (duty.popup.type === 'elective') return 'PM:' + duty.popup.name;
    return null;
  }

  function updateClassLinkButtons() {
    // Update link buttons in the responsibilities card
    document.querySelectorAll('.mf-duty-link-area').forEach(function (area) {
      var classKey = area.getAttribute('data-class-key');
      var isTeacher = area.getAttribute('data-is-teacher') === '1';
      if (!classKey) return;
      var link = classLinks[classKey];
      if (link) {
        area.innerHTML = '<button class="mf-link-btn mf-link-view" data-curriculum-id="' + link.curriculum_id + '">View Plan</button> <button class="mf-link-btn mf-link-classpack" data-class-key="' + classKey + '" data-curriculum-id="' + link.curriculum_id + '">Class Pack</button>';
      } else if (isTeacher) {
        area.innerHTML = '<button class="mf-link-btn mf-link-attach" data-class-key="' + classKey + '">Attach Lesson Plan</button>';
      } else {
        area.innerHTML = '';
      }
    });
    wireClassLinkButtons();
  }

  function wireClassLinkButtons() {
    document.querySelectorAll('.mf-link-view').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var currId = parseInt(btn.getAttribute('data-curriculum-id'), 10);
        if (!currId) return;
        // Open the curriculum detail
        var cred = localStorage.getItem('rw_google_credential');
        fetch('/api/curriculum?id=' + currId, { headers: { 'Authorization': 'Bearer ' + cred } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.curriculum) {
            curriculumState.current = data.curriculum;
            curriculumState.view = 'detail';
            renderCurriculumModal();
          }
        });
      });
    });
    document.querySelectorAll('.mf-link-attach').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var classKey = btn.getAttribute('data-class-key');
        showAttachPicker(classKey);
      });
    });
    document.querySelectorAll('.mf-link-classpack').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var classKey = btn.getAttribute('data-class-key');
        var currId = parseInt(btn.getAttribute('data-curriculum-id'), 10);
        if (!classKey || !currId) return;
        showClassPack(classKey, currId);
      });
    });
  }

  // ──────────────────────────────────────────────
  // PM Class Submissions (replaces the Google Form)
  // ──────────────────────────────────────────────
  // Member-authored submissions for upcoming PM electives. Status lifecycle:
  // submitted → drafted (by VP/PMA) → scheduled, or withdrawn / declined.

  var myClassSubmissions = [];
  // Set from /api/curriculum?action=class-submissions response. True when the
  // caller holds VP / Afternoon Class Liaison, or is the super user.
  var classSubmissionReviewer = false;

  // Whitelists mirror the API normaliser; label maps are for display.
  var SESSION_PREF_VALUES = ['1','2','3','4','5','flexible'];
  var SESSION_PREF_LABELS = {
    '1':'Session 1','2':'Session 2','3':'Session 3','4':'Session 4','5':'Session 5',
    'flexible':'Flexible — any session'
  };
  var HOUR_PREF_VALUES = ['first','last','flexible','2hr-required','2hr-optional'];
  var HOUR_PREF_LABELS = {
    'first':'PM1 — First hour after lunch',
    'last':'PM2 — Last hour before we leave',
    'flexible':'Either PM1 or PM2',
    '2hr-required':'Both PM1 & PM2 — kids commit to both',
    '2hr-optional':'Both PM1 & PM2 — kids can take one or both'
  };
  var ASSISTANT_COUNT_VALUES = [1, 2, 3];
  var SPACE_REQ_VALUES = ['any','pavilion','outside','larger-open','kitchen','dirty','noisy','quiet'];
  var SPACE_REQ_LABELS = {
    any:'Any room', pavilion:'Outside Pavilion', outside:'Outside',
    'larger-open':'Larger open room', kitchen:'Kitchen',
    dirty:'Someplace to get dirty', noisy:'We will be noisy', quiet:'I need quiet, please'
  };
  // Mirrors AGE_RANGE_OPTIONS in the curriculum library so the two places use
  // the same co-op group names. Keys are stable ids; labels are for display.
  var AGE_GROUP_VALUES = [
    'saplings','sassafras','oaks','maples','birch','willows','cedars','pigeons',
    'mixed-younger','mixed-elementary','mixed-older','all-ages'
  ];
  var AGE_GROUP_LABELS = {
    saplings: 'Saplings (3–5)',
    sassafras: 'Sassafras (5–6)',
    oaks: 'Oaks (7–8)',
    maples: 'Maples (8–9)',
    birch: 'Birch (9–10)',
    willows: 'Willows (10–11)',
    cedars: 'Cedars (12–13)',
    pigeons: 'Pigeons (14+)',
    'mixed-younger': 'Mixed: Younger (3–8)',
    'mixed-elementary': 'Mixed: Elementary (5–11)',
    'mixed-older': 'Mixed: Older (8–14)',
    'all-ages': 'All ages'
  };
  var MAX_STUDENT_OPTIONS = [10, 12, 15];

  function escClsAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escClsHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function statusBadge(status) {
    var map = {
      submitted:  { label:'Awaiting review', bg:'#FFF3E0', fg:'#7A4E00' },
      drafted:    { label:'Drafted — planning',  bg:'#E1F0FF', fg:'#0A4A85' },
      scheduled:  { label:'Scheduled',      bg:'#DEF3DE', fg:'#2E6B2E' },
      declined:   { label:'Declined',       bg:'#F7E0E0', fg:'#8A2222' },
      withdrawn:  { label:'Withdrawn',      bg:'#EEE',     fg:'#555'    }
    };
    var s = map[status] || map.submitted;
    return '<span class="mf-classsubs-status" style="background:' + s.bg + ';color:' + s.fg + ';padding:2px 10px;border-radius:999px;font-size:0.75rem;font-weight:600;white-space:nowrap;">' + s.label + '</span>';
  }

  function loadMyClassSubmissions() {
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/curriculum?action=class-submissions&scope=mine', {
      headers: { 'Authorization': 'Bearer ' + cred }
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      myClassSubmissions = Array.isArray(data.submissions) ? data.submissions : [];
      classSubmissionReviewer = !!data.is_reviewer;
      renderClassSubsCardBody();
    })
    .catch(function () {
      var body = document.getElementById('mfClassSubsBody');
      if (body) body.innerHTML = '<em style="color:var(--color-text-light);">Could not load submissions. Refresh to try again.</em>';
    });
  }

  function renderClassSubsCardBody() {
    var body = document.getElementById('mfClassSubsBody');
    if (!body) return;

    var html = '';
    var activeSubs = myClassSubmissions.filter(function (s) { return s.status !== 'withdrawn'; });

    if (activeSubs.length === 0) {
      html += '<p style="margin:0 0 0.75rem;color:var(--color-text-light);font-size:0.9rem;">';
      html += 'You haven\'t proposed a PM class yet.';
      html += '</p>';
    } else {
      html += '<ul class="mf-classsubs-list" style="list-style:none;padding:0;margin:0 0 1rem;">';
      activeSubs.forEach(function (s) {
        var sessText = (s.session_preferences || []).map(function (x) { return SESSION_PREF_LABELS[x] || x; }).join(', ') || '—';
        var canEdit = s.status === 'submitted';
        html += '<li class="mf-classsubs-row" style="border:1px solid var(--color-border);border-radius:10px;padding:0.75rem 1rem;margin-bottom:0.5rem;">';
        html += '<div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;justify-content:space-between;">';
        html += '<strong style="font-size:1rem;">' + escClsHtml(s.class_name) + '</strong>';
        html += statusBadge(s.status);
        html += '</div>';
        html += '<div style="color:var(--color-text-light);font-size:0.85rem;margin-top:3px;">';
        html += 'For: ' + escClsHtml(sessText);
        html += '</div>';
        if (canEdit) {
          html += '<div style="margin-top:0.5rem;display:flex;gap:6px;">';
          html += '<button class="sc-btn mf-classsubs-edit" data-id="' + s.id + '">Edit</button>';
          html += '<button class="sc-btn sc-btn-del mf-classsubs-withdraw" data-id="' + s.id + '">Withdraw</button>';
          html += '</div>';
        } else if (s.status === 'drafted' || s.status === 'scheduled') {
          html += '<div style="margin-top:0.5rem;font-size:0.8rem;color:var(--color-text-light);">';
          html += 'The VP / PM Assistant is planning this one. Contact them for changes.';
          html += '</div>';
        }
        html += '</li>';
      });
      html += '</ul>';
    }

    html += '<button class="btn btn-primary mf-classsubs-new-btn" id="mfSubmitClassBtn" style="padding:10px 22px;font-size:0.95rem;">';
    html += (activeSubs.length === 0 ? '+ Submit a PM Class' : '+ Submit Another Class');
    html += '</button>';

    body.innerHTML = html;

    var newBtn = document.getElementById('mfSubmitClassBtn');
    if (newBtn) newBtn.addEventListener('click', function () { showClassSubmissionModal(null); });

    body.querySelectorAll('.mf-classsubs-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = parseInt(btn.getAttribute('data-id'), 10);
        var sub = myClassSubmissions.filter(function (s) { return s.id === id; })[0];
        if (sub) showClassSubmissionModal(sub);
      });
    });
    body.querySelectorAll('.mf-classsubs-withdraw').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = parseInt(btn.getAttribute('data-id'), 10);
        if (!confirm('Withdraw this class submission? The VP and PM Assistant will be notified it was cancelled.')) return;
        withdrawClassSubmission(id);
      });
    });
  }

  function withdrawClassSubmission(id) {
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/curriculum?action=class-submission&id=' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + cred }
    })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
    .then(function (res) {
      if (!res.ok) { alert('Could not withdraw: ' + (res.data.error || 'unknown error')); return; }
      loadMyClassSubmissions();
    })
    .catch(function () { alert('Network error withdrawing submission.'); });
  }

  // Builds the submission modal (all 13 form fields). `existing` is either
  // null (new submission) or a submission row (edit mode).
  function showClassSubmissionModal(existing) {
    if (document.getElementById('classSubOverlay')) return;
    var isEdit = !!existing;
    var cur = existing || {
      class_name:'', session_preferences:[], hour_preference:[], assistant_count:[],
      co_teachers:'', space_request:[], space_request_other:'',
      max_students: 12, max_students_other:'', age_groups:[], age_groups_other:'',
      pre_enroll_kids:'', open_to_teen_assistant: false,
      prerequisites:'', description:'', other_info:''
    };

    function has(arr, v) { return Array.isArray(arr) && arr.indexOf(v) !== -1; }
    function checkbox(field, value, label) {
      var checked = has(cur[field], (field === 'assistant_count' ? parseInt(value, 10) : value));
      return '<label class="cls-cb-label">' +
        '<input type="checkbox" class="cls-cb" data-field="' + field + '" value="' + escClsAttr(value) + '"' + (checked ? ' checked' : '') + '> ' +
        escClsHtml(label) + '</label>';
    }

    // Max students: pre-select radio or "Other" based on current value
    var isPreset = MAX_STUDENT_OPTIONS.indexOf(parseInt(cur.max_students, 10)) !== -1 && !cur.max_students_other;
    var maxStudentsOtherVal = cur.max_students_other || (!isPreset && cur.max_students ? String(cur.max_students) : '');

    var html = '<div class="cls-overlay" id="classSubOverlay">';
    html += '<div class="cls-modal" role="dialog" aria-modal="true" aria-label="Submit a PM class">';
    html += '<button class="detail-close" id="clsCloseBtn" aria-label="Close">&times;</button>';
    html += '<h3 style="margin:0 0 0.25rem;">' + (isEdit ? 'Edit PM Class Submission' : 'Submit a PM Class') + '</h3>';
    html += '<p style="color:var(--color-text-light);font-size:0.9rem;margin:0 0 1rem;">';
    html += 'The VP and Afternoon Class Liaison will reach out when they\'re planning the next session.';
    html += '</p>';
    // Placeholder for the "Need inspiration?" strip — filled asynchronously
    // by loadInspirationStrip() so the modal opens instantly even if the
    // curriculum fetch is slow.
    if (!isEdit) {
      html += '<div id="clsInspiration" class="cls-inspire" style="display:none;"></div>';
    }
    html += '<form id="clsForm" novalidate>';

    // 1. Class Name
    html += '<div class="cls-field">';
    html += '<label class="cls-label">Class Name <span class="cls-req">*</span></label>';
    html += '<input class="cl-input cls-input" type="text" id="clsClassName" maxlength="200" value="' + escClsAttr(cur.class_name) + '" required>';
    html += '</div>';

    // 2. Description (moved up from #12 so it sits with Class Name)
    html += '<div class="cls-field">';
    html += '<label class="cls-label">Brief description <span class="cls-req">*</span></label>';
    html += '<p class="cls-help">Just a start — can get updated along the way.</p>';
    html += '<textarea class="cl-input cls-textarea" id="clsDescription" rows="4" maxlength="3000" required>' + escClsHtml(cur.description) + '</textarea>';
    html += '</div>';

    // 3. Session preferences
    html += '<div class="cls-field">';
    html += '<label class="cls-label">Which session(s)? <span class="cls-req">*</span></label>';
    html += '<p class="cls-help">You\'ll be notified when your class is added to the roster.</p>';
    html += '<div class="cls-cb-group">';
    SESSION_PREF_VALUES.forEach(function (v) { html += checkbox('session_preferences', v, SESSION_PREF_LABELS[v]); });
    html += '</div></div>';

    // 4. Hour preference
    html += '<div class="cls-field">';
    html += '<label class="cls-label">Which afternoon hour? <span class="cls-req">*</span></label>';
    html += '<div class="cls-cb-group">';
    HOUR_PREF_VALUES.forEach(function (v) { html += checkbox('hour_preference', v, HOUR_PREF_LABELS[v]); });
    html += '</div></div>';

    // 5. Number of assistants
    html += '<div class="cls-field">';
    html += '<label class="cls-label">How many helpers? <span class="cls-req">*</span></label>';
    html += '<div class="cls-cb-group cls-cb-inline">';
    ASSISTANT_COUNT_VALUES.forEach(function (n) { html += checkbox('assistant_count', String(n), n + ' Classroom assistant' + (n > 1 ? 's' : '')); });
    html += '</div>';
    html += '<label class="cls-cb-label" style="margin-top:8px;">';
    html += '<input type="checkbox" id="clsTeenAssist"' + (cur.open_to_teen_assistant ? ' checked' : '') + '> ';
    html += 'Willing to host a Cedars or Pigeons (12+) assistant';
    html += '</label>';
    html += '</div>';

    // 6. Co-teachers
    html += '<div class="cls-field">';
    html += '<label class="cls-label">Co-teachers or assistants already identified?</label>';
    html += '<input class="cl-input cls-input" type="text" id="clsCoTeachers" maxlength="500" value="' + escClsAttr(cur.co_teachers) + '" placeholder="Names (optional)">';
    html += '</div>';

    // 7. Space request
    html += '<div class="cls-field">';
    html += '<label class="cls-label">Space request <span class="cls-req">*</span></label>';
    html += '<div class="cls-cb-group">';
    SPACE_REQ_VALUES.forEach(function (v) { html += checkbox('space_request', v, SPACE_REQ_LABELS[v]); });
    html += '</div>';
    html += '<input class="cl-input cls-input" type="text" id="clsSpaceOther" maxlength="300" value="' + escClsAttr(cur.space_request_other) + '" placeholder="Other (optional)" style="margin-top:8px;">';
    html += '</div>';

    // 8. Max students
    html += '<div class="cls-field">';
    html += '<label class="cls-label">Maximum class size <span class="cls-req">*</span></label>';
    html += '<div class="cls-cb-group cls-cb-inline">';
    MAX_STUDENT_OPTIONS.forEach(function (n) {
      var checked = isPreset && parseInt(cur.max_students, 10) === n;
      html += '<label class="cls-cb-label"><input type="radio" name="clsMaxStudents" value="' + n + '"' + (checked ? ' checked' : '') + '> ' + n + '</label>';
    });
    html += '<label class="cls-cb-label"><input type="radio" name="clsMaxStudents" value="other"' + (!isPreset && maxStudentsOtherVal ? ' checked' : '') + '> Other:</label>';
    html += '<input class="cl-input cls-input" type="number" id="clsMaxStudentsOther" min="1" max="100" value="' + escClsAttr(maxStudentsOtherVal) + '" style="width:6rem;" placeholder="#">';
    html += '</div></div>';

    // 9. Age groups
    html += '<div class="cls-field">';
    html += '<label class="cls-label">Age group(s) the class is designed for <span class="cls-req">*</span></label>';
    html += '<div class="cls-cb-group">';
    AGE_GROUP_VALUES.forEach(function (v) { html += checkbox('age_groups', v, AGE_GROUP_LABELS[v]); });
    html += '</div>';
    html += '<input class="cl-input cls-input" type="text" id="clsAgeOther" maxlength="200" value="' + escClsAttr(cur.age_groups_other) + '" placeholder="Other (optional)" style="margin-top:8px;">';
    html += '</div>';

    // (Pre-enroll your own kids is deferred to a later flow.)

    // 11. Prerequisites
    html += '<div class="cls-field">';
    html += '<label class="cls-label">Prerequisites or items students supply?</label>';
    html += '<textarea class="cl-input cls-textarea" id="clsPrereq" rows="2" maxlength="1000">' + escClsHtml(cur.prerequisites) + '</textarea>';
    html += '</div>';

    // 12. Other info
    html += '<div class="cls-field">';
    html += '<label class="cls-label">Anything else that would help plan or support this class?</label>';
    html += '<textarea class="cl-input cls-textarea" id="clsOtherInfo" rows="3" maxlength="2000">' + escClsHtml(cur.other_info) + '</textarea>';
    html += '</div>';

    // Error + submit
    html += '<div id="clsError" class="cls-error" style="display:none;"></div>';
    html += '<div class="cls-actions">';
    html += '<button type="button" class="sc-btn" id="clsCancelBtn">Cancel</button>';
    html += '<button type="submit" class="btn btn-primary" id="clsSubmitBtn">' + (isEdit ? 'Save Changes' : 'Submit Class') + '</button>';
    html += '</div>';

    html += '</form>';
    html += '</div></div>';

    document.body.insertAdjacentHTML('beforeend', html);
    document.body.style.overflow = 'hidden';
    var overlay = document.getElementById('classSubOverlay');
    var form = document.getElementById('clsForm');

    function closeCls() { overlay.remove(); document.body.style.overflow = ''; }
    document.getElementById('clsCloseBtn').addEventListener('click', closeCls);
    document.getElementById('clsCancelBtn').addEventListener('click', closeCls);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeCls(); });

    if (!isEdit) loadInspirationStrip();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var errEl = document.getElementById('clsError');
      errEl.style.display = 'none';
      errEl.textContent = '';

      function collectChecked(field) {
        var vals = [];
        overlay.querySelectorAll('input.cls-cb[data-field="' + field + '"]').forEach(function (cb) {
          if (cb.checked) vals.push(cb.value);
        });
        return vals;
      }

      var maxSel = overlay.querySelector('input[name="clsMaxStudents"]:checked');
      var max_students, max_students_other = '';
      if (!maxSel) {
        errEl.textContent = 'Pick a maximum class size.'; errEl.style.display = ''; return;
      }
      if (maxSel.value === 'other') {
        var otherVal = parseInt(document.getElementById('clsMaxStudentsOther').value, 10);
        if (!Number.isFinite(otherVal) || otherVal <= 0) {
          errEl.textContent = 'Enter a number for the custom class size.'; errEl.style.display = ''; return;
        }
        max_students = otherVal;
        max_students_other = String(otherVal);
      } else {
        max_students = parseInt(maxSel.value, 10);
      }

      var payload = {
        class_name: document.getElementById('clsClassName').value.trim(),
        description: document.getElementById('clsDescription').value.trim(),
        session_preferences: collectChecked('session_preferences'),
        hour_preference: collectChecked('hour_preference'),
        assistant_count: collectChecked('assistant_count').map(function (v) { return parseInt(v, 10); }),
        co_teachers: document.getElementById('clsCoTeachers').value.trim(),
        space_request: collectChecked('space_request'),
        space_request_other: document.getElementById('clsSpaceOther').value.trim(),
        max_students: max_students,
        max_students_other: max_students_other,
        age_groups: collectChecked('age_groups'),
        age_groups_other: document.getElementById('clsAgeOther').value.trim(),
        pre_enroll_kids: cur.pre_enroll_kids || '', // field not in v1 UI, preserve existing value on edit
        open_to_teen_assistant: document.getElementById('clsTeenAssist').checked,
        prerequisites: document.getElementById('clsPrereq').value.trim(),
        other_info: document.getElementById('clsOtherInfo').value.trim()
      };

      var submitBtn = document.getElementById('clsSubmitBtn');
      submitBtn.disabled = true;
      submitBtn.textContent = isEdit ? 'Saving…' : 'Submitting…';

      var cred = localStorage.getItem('rw_google_credential');
      var url = '/api/curriculum?action=class-submission' + (isEdit ? '&id=' + existing.id : '');
      var method = isEdit ? 'PATCH' : 'POST';
      fetch(url, {
        method: method,
        headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          errEl.textContent = res.data.error || 'Could not save submission.';
          errEl.style.display = '';
          submitBtn.disabled = false;
          submitBtn.textContent = isEdit ? 'Save Changes' : 'Submit Class';
          return;
        }
        closeCls();
        loadMyClassSubmissions();
      })
      .catch(function () {
        errEl.textContent = 'Network error — please try again.';
        errEl.style.display = '';
        submitBtn.disabled = false;
        submitBtn.textContent = isEdit ? 'Save Changes' : 'Submit Class';
      });
    });
  }

  // Loads favorited PM/both curricula and renders a "Need inspiration?" strip
  // inside the Submit modal. Best-effort — strip stays hidden on failure.
  function loadInspirationStrip() {
    var strip = document.getElementById('clsInspiration');
    if (!strip) return;
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/curriculum?action=inspiration', {
      headers: { 'Authorization': 'Bearer ' + cred }
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var list = Array.isArray(data.curricula) ? data.curricula : [];
      if (list.length === 0) return; // keep hidden — no favorites yet
      renderInspirationStrip(list.slice(0, 6));
    })
    .catch(function () { /* best-effort */ });
  }

  function renderInspirationStrip(list) {
    var strip = document.getElementById('clsInspiration');
    if (!strip) return;
    var html = '<div class="cls-inspire-head">⭐ <strong>Need inspiration?</strong> ';
    html += '<span style="color:var(--color-text-light);font-size:0.85rem;">Past PM classes kids loved — click to use as a starting point.</span></div>';
    html += '<div class="cls-inspire-grid">';
    list.forEach(function (c) {
      var overview = (c.overview || '').slice(0, 120);
      html += '<button type="button" class="cls-inspire-card" data-id="' + c.id + '">';
      html += '<strong>' + escClsHtml(c.title) + '</strong>';
      var meta = [];
      if (c.subject) meta.push(escClsHtml(c.subject));
      if (c.age_range) meta.push(escClsHtml(c.age_range));
      if (meta.length) html += '<div class="cls-inspire-meta">' + meta.join(' · ') + '</div>';
      if (overview) html += '<div class="cls-inspire-desc">' + escClsHtml(overview) + (c.overview.length > 120 ? '…' : '') + '</div>';
      html += '<span class="cls-inspire-use">Use this as my class →</span>';
      html += '</button>';
    });
    html += '</div>';
    strip.innerHTML = html;
    strip.style.display = '';

    strip.querySelectorAll('.cls-inspire-card').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = parseInt(btn.getAttribute('data-id'), 10);
        var picked = list.filter(function (c) { return c.id === id; })[0];
        if (!picked) return;
        applyInspirationPrefill(picked);
      });
    });
  }

  // Copy fields from a favorited curriculum into the current submit form.
  // Only fills empty fields so we don't clobber anything the user typed.
  function applyInspirationPrefill(curr) {
    var titleEl = document.getElementById('clsClassName');
    var descEl = document.getElementById('clsDescription');
    if (titleEl && !titleEl.value.trim()) titleEl.value = curr.title || '';
    if (descEl && !descEl.value.trim()) descEl.value = curr.overview || '';
    // Best-effort age-group inference from curriculum.age_range → checkbox keys.
    var inferred = inferAgeGroups(curr.age_range);
    if (inferred.length > 0) {
      inferred.forEach(function (g) {
        var cb = document.querySelector('input.cls-cb[data-field="age_groups"][value="' + g + '"]');
        if (cb && !cb.checked) cb.checked = true;
      });
    }
    // Scroll the class-name field into view so it's obvious something happened.
    if (titleEl) titleEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (titleEl) titleEl.focus();
  }

  // Map the library's free-form age_range string to AGE_GROUP_VALUES keys.
  // AGE_RANGE_OPTIONS lives in the curriculum editor — we just match on
  // name substrings so "Saplings (3-5)" → ['saplings'], "Mixed: Older" →
  // ['mixed-older'], etc.
  function inferAgeGroups(ageRange) {
    if (!ageRange) return [];
    var s = String(ageRange).toLowerCase();
    var map = [
      ['saplings', 'saplings'],
      ['sassafras', 'sassafras'],
      ['oaks', 'oaks'],
      ['maples', 'maples'],
      ['birch', 'birch'],
      ['willows', 'willows'],
      ['cedars', 'cedars'],
      ['pigeons', 'pigeons'],
      ['mixed: younger', 'mixed-younger'],
      ['mixed: elementary', 'mixed-elementary'],
      ['mixed: older', 'mixed-older'],
      ['all ages', 'all-ages']
    ];
    var out = [];
    map.forEach(function (pair) {
      if (s.indexOf(pair[0]) !== -1) out.push(pair[1]);
    });
    return out;
  }

  // ──────────────────────────────────────────────
  // Schedule Builder (VP + Afternoon Class Liaison)
  // ──────────────────────────────────────────────
  // Visual grid for drafting PM electives: rows = 4 age sections, cols =
  // PM1 / PM2. 2-hour classes span both cells of their row. Reviewers click
  // a cell to pull in matching submissions from the inbox or unschedule a
  // class already in the cell. Mirrors the look of Coordination → Current
  // Session so planners have a familiar mental model.

  var SCHEDULE_SECTIONS = [
    { id: 'little',  label: 'Little (3–6)',
      groups: ['saplings', 'sassafras'],
      matches: ['saplings', 'sassafras', 'mixed-younger', 'all-ages'] },
    { id: 'younger', label: 'Younger (7–9)',
      groups: ['oaks', 'maples'],
      matches: ['oaks', 'maples', 'mixed-younger', 'mixed-elementary', 'all-ages'] },
    { id: 'older',   label: 'Older (9–11)',
      groups: ['birch', 'willows'],
      matches: ['birch', 'willows', 'mixed-elementary', 'mixed-older', 'all-ages'] },
    { id: 'teen',    label: 'Teen (12+)',
      groups: ['cedars', 'pigeons'],
      matches: ['cedars', 'pigeons', 'mixed-older', 'all-ages'] }
  ];
  var SCHEDULE_HOURS = ['PM1', 'PM2'];

  var scheduleBuilderState = {
    schoolYear: '2026-2027',
    session: 1,
    submissions: [],  // all submissions for the school year
    loaded: false
  };

  // ══════════════════════════════════════════════
  // PM Submissions Report (in the PM Class Scheduling workspace card)
  // ══════════════════════════════════════════════
  // Quick-triage list view of /api/curriculum?action=class-submissions.
  // The Schedule Builder (opens in an overlay) is the right place for
  // visual placement; this in-card table is the scannable list VP/PMA
  // asked for — filter by status/session/age/year, see counts, and do
  // fast approve (→drafted) or decline (→declined) per row.
  var _pmReportState = {
    loaded: false,
    submissions: [],
    filters: { status: 'submitted', session: 'all', age: 'all', school_year: '2026-2027' }
  };

  // ══════════════════════════════════════════════
  // Roles Manager (President workspace widget → modal)
  // ══════════════════════════════════════════════
  // Reads /api/cleaning?action=roles&includeArchived=1, renders the full
  // hierarchy grouped by board chair, with inline Edit, Archive/Restore,
  // and "+ Add Role" actions. Persists edits via PATCH/POST to the same
  // endpoint. Server-side permissions enforce that only the President +
  // super user can change meta fields or create/archive roles.
  var _rolesMgrState = {
    roles: [],
    holdersByRoleId: {}, // { role_id: [ {id, email, person_name, family_name}, ... ] }
    showArchived: false,
    // Defaults to the active school year (April flip), same logic as
    // BILLING_CONFIG. Past years stay accessible via the picker.
    schoolYear: ACTIVE_YEAR.label
  };
  var ROLES_MGR_YEARS = (function () {
    var years = [];
    var fy = ACTIVE_YEAR.fallYear;
    // Show the current active year + the prior year so a Membership
    // Director who's mid-transition can still see / edit historical
    // assignments without code changes.
    years.push((fy - 1) + '-' + fy);
    years.push(fy + '-' + (fy + 1));
    return years;
  })();

  function loadRolesManagerCount() {
    var pill = document.getElementById('rolesmgr-count');
    if (!pill) return;
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/cleaning?action=roles&includeArchived=1', {
      headers: { 'Authorization': 'Bearer ' + cred }
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        // Only update the pill — don't touch _rolesMgrState, since the
        // modal needs to fetch roles + holders together in a single
        // consistent pass when it opens.
        var roles = Array.isArray(data.roles) ? data.roles : [];
        var active = roles.filter(function (r) { return r.status === 'active'; }).length;
        pill.textContent = active + ' active';
        pill.hidden = false;
      })
      .catch(function () { /* silent — pill stays hidden */ });
  }

  function showRolesManagerModal() {
    if (!personDetail || !personDetailCard) return;
    var h = '<div class="detail-actions no-print">';
    h += '<button class="sc-btn" type="button" id="roles-add-btn">+ Add Role</button>';
    h += '</div>';
    h += '<button class="detail-close" aria-label="Close">&times;</button>';
    h += '<div class="elective-detail rd-modal roles-mgr-modal">';
    h += '<h3 class="rd-title">Roles &amp; Committees</h3>';
    h += '<p class="rd-subtitle">Every job description, term, and hierarchy in one place. Edits are stamped with who and when.</p>';
    h += '<div class="roles-mgr-toolbar">';
    h += '<label class="roles-mgr-yearpick">School year ';
    h += '<select id="roles-school-year">';
    ROLES_MGR_YEARS.forEach(function (yr) {
      var sel = yr === _rolesMgrState.schoolYear ? ' selected' : '';
      h += '<option value="' + yr + '"' + sel + '>' + yr + '</option>';
    });
    h += '</select>';
    h += '</label>';
    h += '<label class="roles-mgr-toggle"><input type="checkbox" id="roles-show-archived"' + (_rolesMgrState.showArchived ? ' checked' : '') + ' /> Show archived</label>';
    h += '</div>';
    h += '<div id="roles-mgr-body"><p class="ws-empty">Loading roles…</p></div>';
    h += '</div>';
    personDetailCard.innerHTML = h;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) { if (e.target === personDetail) closeDetail(); });

    document.getElementById('roles-show-archived').addEventListener('change', function () {
      _rolesMgrState.showArchived = this.checked;
      renderRolesManagerTree();
    });
    document.getElementById('roles-school-year').addEventListener('change', function () {
      _rolesMgrState.schoolYear = this.value;
      loadRolesManagerTree();
    });
    document.getElementById('roles-add-btn').addEventListener('click', function () {
      showRoleEditModal(null);
    });
    loadRolesManagerTree();
  }

  function loadRolesManagerTree() {
    var body = document.getElementById('roles-mgr-body');
    if (!body) return;
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) { body.innerHTML = '<p class="ws-empty">Sign-in required.</p>'; return; }
    body.innerHTML = '<p class="ws-empty">Loading roles…</p>';
    // Fetch roles + current-year holders in parallel. Holders are Phase A
    // read-only — displayed on each row to show who currently holds it.
    var rolesReq = fetch('/api/cleaning?action=roles&includeArchived=1', {
      headers: { 'Authorization': 'Bearer ' + cred }
    });
    var holdersReq = fetch('/api/cleaning?action=role-holders&school_year=' + encodeURIComponent(_rolesMgrState.schoolYear), {
      headers: { 'Authorization': 'Bearer ' + cred }
    });
    Promise.all([rolesReq, holdersReq])
      .then(function (responses) {
        return Promise.all(responses.map(function (r) {
          return r.json().then(function (d) { return { ok: r.ok, data: d }; });
        }));
      })
      .then(function (results) {
        var rolesRes = results[0];
        var holdersRes = results[1];
        if (!rolesRes.ok) {
          body.innerHTML = '<p class="ws-empty">' + escapeHtml((rolesRes.data && rolesRes.data.error) || 'Could not load roles.') + '</p>';
          return;
        }
        _rolesMgrState.roles = Array.isArray(rolesRes.data.roles) ? rolesRes.data.roles : [];
        _rolesMgrState.holdersByRoleId = {};
        var holdersArr = (holdersRes.ok && holdersRes.data && Array.isArray(holdersRes.data.holders)) ? holdersRes.data.holders : [];
        holdersArr.forEach(function (h) {
          var k = h.role_id;
          if (!_rolesMgrState.holdersByRoleId[k]) _rolesMgrState.holdersByRoleId[k] = [];
          _rolesMgrState.holdersByRoleId[k].push(h);
        });
        renderRolesManagerTree();
      })
      .catch(function (err) {
        body.innerHTML = '<p class="ws-empty">Network error: ' + escapeHtml(err.message || 'unknown') + '</p>';
      });
  }

  function renderRolesManagerTree() {
    var body = document.getElementById('roles-mgr-body');
    if (!body) return;
    var roles = _rolesMgrState.roles || [];
    var show = _rolesMgrState.showArchived;
    var visible = roles.filter(function (r) { return show || r.status !== 'archived'; });

    // Group: board → children (by parent_role_id).
    var byId = {};
    visible.forEach(function (r) { byId[r.id] = r; });
    var boards = visible.filter(function (r) { return r.category === 'board'; })
      .sort(function (a, b) { return a.display_order - b.display_order || a.title.localeCompare(b.title); });
    var childrenOf = {};
    visible.forEach(function (r) {
      if (r.parent_role_id) {
        (childrenOf[r.parent_role_id] = childrenOf[r.parent_role_id] || []).push(r);
      }
    });
    Object.keys(childrenOf).forEach(function (k) {
      childrenOf[k].sort(function (a, b) {
        // Archived sinks below active; then by display_order; then by title.
        if ((a.status === 'archived') !== (b.status === 'archived')) return a.status === 'archived' ? 1 : -1;
        return a.display_order - b.display_order || a.title.localeCompare(b.title);
      });
    });
    var orphans = visible.filter(function (r) {
      return r.category !== 'board' && !byId[r.parent_role_id];
    });

    var h = '';
    function renderRow(r, depth) {
      var archived = r.status === 'archived';
      var classes = 'roles-row roles-row-depth-' + depth + (archived ? ' roles-row-archived' : '');
      var h2 = '<div class="' + classes + '" data-role-id="' + r.id + '">';
      h2 += '<div class="roles-row-main">';
      h2 += '<button type="button" class="roles-row-title" data-role-id="' + r.id + '">' + escapeHtml(r.title) + '</button>';
      h2 += '<div class="roles-row-pills">';
      if (r.job_length) h2 += '<span class="roles-pill roles-pill-term">' + escapeHtml(r.job_length) + '</span>';
      h2 += '<span class="roles-pill roles-pill-cat roles-pill-cat-' + r.category + '">' + escapeHtml(r.category.replace(/_/g, ' ')) + '</span>';
      if (archived) h2 += '<span class="roles-pill roles-pill-archived">archived</span>';
      h2 += '</div>';
      h2 += '<div class="roles-row-actions">';
      h2 += '<button type="button" class="sc-btn roles-row-edit" data-role-id="' + r.id + '" aria-label="Edit ' + escapeHtml(r.title) + '">Edit</button>';
      if (archived) {
        h2 += '<button type="button" class="sc-btn roles-row-restore" data-role-id="' + r.id + '" aria-label="Restore ' + escapeHtml(r.title) + '">Restore</button>';
      } else {
        h2 += '<button type="button" class="sc-btn sc-btn-del roles-row-archive" data-role-id="' + r.id + '" aria-label="Archive ' + escapeHtml(r.title) + '">Archive</button>';
      }
      h2 += '</div>';
      h2 += '</div>';
      // Holder line sits directly under title/pills (before overview)
      // so the first thing a reviewer scans is "who is this?". Phase A
      // is read-only — Phase B adds the Assign button in this slot.
      // Skip the line for roles whose assignments live elsewhere:
      //   - cleaning_area: per-session assignments in cleaning_assignments
      //   - Classroom Instructor / Assistant / Floater / Morning Class
      //     Liaison: per-class staffing in AM_CLASSES, not the volunteer
      //     sheet. Showing "Unassigned" misled reviewers into thinking
      //     these were vacant.
      var holderManagedElsewhere = r.category === 'cleaning_area' ||
        r.title === 'Classroom Instructor' ||
        r.title === 'Classroom Assistant' ||
        r.title === 'Floater' ||
        r.title === 'Morning Class Liaison';
      if (!holderManagedElsewhere) {
        var held = (_rolesMgrState.holdersByRoleId && _rolesMgrState.holdersByRoleId[r.id]) || [];
        h2 += '<div class="roles-row-holder-line">';
        if (held.length === 0) {
          h2 += '<span class="roles-row-holder roles-row-holder-empty">Unassigned</span>';
        } else {
          h2 += '<span class="roles-row-holder-label">Held by</span> ';
          h2 += '<span class="roles-row-holder">';
          h2 += held.map(function (hh) {
            return '<span class="roles-row-holder-chip">' +
              escapeHtml(hh.person_name || hh.email) +
              '<button type="button" class="roles-row-holder-remove" data-holder-id="' + hh.id +
              '" data-holder-name="' + escapeHtml(hh.person_name || hh.email) +
              '" aria-label="Remove ' + escapeHtml(hh.person_name || hh.email) + '">&times;</button>' +
              '</span>';
          }).join(' ');
          h2 += '</span>';
        }
        h2 += ' <button type="button" class="sc-btn roles-row-assign" data-role-id="' + r.id + '" aria-label="Assign holder for ' + escapeHtml(r.title) + '">Assign</button>';
        h2 += '</div>';
      }
      h2 += '<div class="roles-row-meta">';
      if (r.overview) h2 += '<span class="roles-row-overview">' + escapeHtml(String(r.overview).slice(0, 120)) + (String(r.overview).length > 120 ? '…' : '') + '</span>';
      var stampBits = [];
      if (r.updated_by) stampBits.push(escapeHtml(r.updated_by));
      if (r.updated_at) {
        try { stampBits.push(new Date(r.updated_at).toLocaleDateString()); } catch (e) { /* ignore */ }
      }
      if (stampBits.length) h2 += '<span class="roles-row-stamp">Updated ' + stampBits.join(' · ') + '</span>';
      h2 += '</div>';
      h2 += '</div>';
      return h2;
    }
    function renderBranch(row, depth) {
      var out = renderRow(row, depth);
      var kids = childrenOf[row.id] || [];
      kids.forEach(function (k) { out += renderBranch(k, depth + 1); });
      return out;
    }

    if (boards.length === 0 && orphans.length === 0) {
      body.innerHTML = '<p class="ws-empty">No roles match. Uncheck "Show archived" or add one with the + button.</p>';
      return;
    }
    boards.forEach(function (b) {
      h += '<section class="roles-branch">';
      h += renderBranch(b, 0);
      h += '</section>';
    });
    if (orphans.length) {
      h += '<section class="roles-branch roles-branch-orphans">';
      h += '<h5 class="roles-branch-head">Unassigned</h5>';
      orphans.sort(function (a, b) { return a.title.localeCompare(b.title); }).forEach(function (o) {
        h += renderRow(o, 0);
      });
      h += '</section>';
    }
    body.innerHTML = h;

    function findRoleById(id) {
      return _rolesMgrState.roles.find(function (r) { return r.id === id; });
    }
    body.querySelectorAll('.roles-row-title, .roles-row-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = parseInt(this.getAttribute('data-role-id'), 10);
        var role = findRoleById(id);
        if (role) showRoleEditModal(role);
      });
    });
    body.querySelectorAll('.roles-row-archive').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = parseInt(this.getAttribute('data-role-id'), 10);
        var role = findRoleById(id);
        if (!role) return;
        if (!confirm('Archive "' + role.title + '"? It stays in the database for history but hides from the default list. You can restore it from "Show archived".')) return;
        patchRoleStatusInline(id, 'archived');
      });
    });
    body.querySelectorAll('.roles-row-restore').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = parseInt(this.getAttribute('data-role-id'), 10);
        patchRoleStatusInline(id, 'active');
      });
    });
    body.querySelectorAll('.roles-row-assign').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = parseInt(this.getAttribute('data-role-id'), 10);
        var role = findRoleById(id);
        if (role) showAssignHolderModal(role);
      });
    });
    body.querySelectorAll('.roles-row-holder-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var holderId = parseInt(this.getAttribute('data-holder-id'), 10);
        var name = this.getAttribute('data-holder-name') || 'this person';
        if (!confirm('Remove ' + name + ' from this role for ' + _rolesMgrState.schoolYear + '?')) return;
        deleteRoleHolder(holderId);
      });
    });
  }

  function patchRoleStatusInline(id, nextStatus) {
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/cleaning?action=roles&id=' + id, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          alert((res.data && res.data.error) || 'Could not update role (' + res.status + ')');
          return;
        }
        loadRolesManagerTree();
        if (typeof loadRolesManagerCount === 'function') loadRolesManagerCount();
      })
      .catch(function (err) { alert('Network error: ' + (err.message || 'unknown')); });
  }

  // Phase B: assign a parent to a role for the active school year. Uses
  // the reusable buildParentPickerOptions() source so the dropdown stays
  // consistent with the coverage-assign flow. Hides parents who already
  // hold this role for this year so the President doesn't double-add by
  // accident.
  function showAssignHolderModal(role) {
    if (document.getElementById('roleHolderOverlay')) return;
    var year = _rolesMgrState.schoolYear;
    var held = (_rolesMgrState.holdersByRoleId && _rolesMgrState.holdersByRoleId[role.id]) || [];
    var alreadyHeldEmails = {};
    held.forEach(function (h) { alreadyHeldEmails[String(h.email).toLowerCase()] = true; });
    var allOpts = buildParentPickerOptions().filter(function (o) {
      return !alreadyHeldEmails[o.email.toLowerCase()];
    });

    var html = '<div class="absence-overlay" id="roleHolderOverlay"><div class="absence-modal">';
    html += '<button class="detail-close absence-close" id="roleHolderCloseBtn" aria-label="Close">&times;</button>';
    html += '<h3>Assign holder</h3>';
    html += '<p class="assign-coverage-slot"><strong>' + escapeHtml(role.title) + '</strong> · ' + escapeHtml(year) + '</p>';
    html += '<div class="absence-field"><label for="roleHolderPerson">Who is taking this role?</label>';
    html += '<select class="cl-input" id="roleHolderPerson">';
    html += '<option value="">— Pick a parent —</option>';
    allOpts.forEach(function (p) {
      html += '<option value="' + escapeHtml(p.email) + '" data-name="' + escapeHtml(p.person_name) +
        '" data-family="' + escapeHtml(p.family_name) + '">' + escapeHtml(p.displayName) + '</option>';
    });
    html += '</select></div>';
    html += '<button class="btn btn-primary absence-submit" id="roleHolderSubmitBtn">Assign</button>';
    html += '</div></div>';
    document.body.insertAdjacentHTML('beforeend', html);

    var overlay = document.getElementById('roleHolderOverlay');
    function close() { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    document.getElementById('roleHolderCloseBtn').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    document.getElementById('roleHolderSubmitBtn').addEventListener('click', function () {
      var sel = document.getElementById('roleHolderPerson');
      if (!sel || !sel.value) { alert('Please pick a parent.'); return; }
      var opt = sel.options[sel.selectedIndex];
      var payload = {
        role_id: role.id,
        email: sel.value,
        person_name: opt.getAttribute('data-name') || '',
        family_name: opt.getAttribute('data-family') || '',
        school_year: year
      };
      var btn = this;
      btn.disabled = true; btn.textContent = 'Assigning…';
      var cred = localStorage.getItem('rw_google_credential');
      fetch('/api/cleaning?action=role-holders', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
        .then(function (res) {
          if (!res.ok) {
            alert((res.data && res.data.error) || 'Could not assign (' + res.status + ')');
            btn.disabled = false; btn.textContent = 'Assign';
            return;
          }
          close();
          loadRolesManagerTree();
        })
        .catch(function (err) {
          alert('Network error: ' + (err.message || 'unknown'));
          btn.disabled = false; btn.textContent = 'Assign';
        });
    });
  }

  function deleteRoleHolder(holderId) {
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/cleaning?action=role-holders&id=' + holderId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + cred }
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          alert((res.data && res.data.error) || 'Could not remove (' + res.status + ')');
          return;
        }
        loadRolesManagerTree();
      })
      .catch(function (err) { alert('Network error: ' + (err.message || 'unknown')); });
  }

  // Dedicated edit / create modal. Uses a second overlay so closing it
  // doesn't close the Roles Manager behind it.
  function showRoleEditModal(role) {
    var isNew = !role;
    var existing = role || {
      id: null, role_key: '', title: '', job_length: '', committee: '',
      parent_role_id: null, category: 'committee_role', status: 'active',
      display_order: 0, overview: '', duties: [], playbook: '',
      last_reviewed_by: '', last_reviewed_date: ''
    };

    var overlay = document.createElement('div');
    overlay.className = 'role-edit-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    // Build parent dropdown from current loaded roles (excluding self to
    // prevent a cycle). Board roles top, then others alphabetized.
    var parentOptions = '<option value="">— no parent (top level) —</option>';
    var candidates = (_rolesMgrState.roles || []).filter(function (r) { return r.id !== existing.id; });
    candidates.sort(function (a, b) {
      if ((a.category === 'board') !== (b.category === 'board')) return a.category === 'board' ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
    candidates.forEach(function (r) {
      var sel = String(existing.parent_role_id || '') === String(r.id) ? ' selected' : '';
      parentOptions += '<option value="' + r.id + '"' + sel + '>' + escapeHtml(r.title) + ' (' + r.category.replace(/_/g, ' ') + ')</option>';
    });

    function catOption(value, label) {
      return '<option value="' + value + '"' + (existing.category === value ? ' selected' : '') + '>' + label + '</option>';
    }

    var h = '<div class="role-edit-card" role="document">';
    h += '<button class="detail-close role-edit-close" aria-label="Close">&times;</button>';
    h += '<h3 class="rd-title">' + (isNew ? 'Add a Role' : 'Edit Role') + '</h3>';
    h += '<form class="role-edit-form" id="roleEditForm">';
    h += '<div class="role-edit-grid">';
    h += '<label class="role-edit-field role-edit-field-wide">Title<input type="text" name="title" required maxlength="120" value="' + escapeHtml(existing.title) + '" /></label>';
    if (isNew) {
      h += '<label class="role-edit-field">Role key (lowercase, unique)<input type="text" name="role_key" required pattern="[a-z0-9_]+" maxlength="80" value="' + escapeHtml(existing.role_key) + '" /></label>';
    }
    h += '<label class="role-edit-field">Term<input type="text" name="job_length" placeholder="e.g., 1 year, 1 session" maxlength="60" value="' + escapeHtml(existing.job_length) + '" /></label>';
    h += '<label class="role-edit-field">Committee<input type="text" name="committee" maxlength="120" value="' + escapeHtml(existing.committee) + '" /></label>';
    h += '<label class="role-edit-field">Category<select name="category">';
    h += catOption('committee_role', 'Committee Role');
    h += catOption('board', 'Board');
    h += catOption('cleaning_area', 'Cleaning Area');
    h += catOption('class', 'Class');
    h += '</select></label>';
    h += '<label class="role-edit-field role-edit-field-wide">Parent role<select name="parent_role_id">' + parentOptions + '</select></label>';
    h += '<label class="role-edit-field">Status<select name="status">';
    h += '<option value="active"' + (existing.status !== 'archived' ? ' selected' : '') + '>Active</option>';
    h += '<option value="archived"' + (existing.status === 'archived' ? ' selected' : '') + '>Archived</option>';
    h += '</select></label>';
    h += '<label class="role-edit-field">Display order<input type="number" name="display_order" step="1" value="' + (existing.display_order || 0) + '" /></label>';
    h += '<label class="role-edit-field role-edit-field-wide">Overview<textarea name="overview" rows="3">' + escapeHtml(existing.overview || '') + '</textarea></label>';
    h += '<label class="role-edit-field role-edit-field-wide">Duties (one per line)<textarea name="duties" rows="6">' + escapeHtml((existing.duties || []).join('\n')) + '</textarea></label>';
    h += '<label class="role-edit-field role-edit-field-wide">Playbook / handoff notes<textarea name="playbook" rows="4">' + escapeHtml(existing.playbook || '') + '</textarea></label>';
    h += '</div>';
    h += '<div class="role-edit-footer">';
    h += '<p class="role-edit-err" id="roleEditErr" aria-live="polite" style="display:none;"></p>';
    h += '<div class="role-edit-actions">';
    if (!isNew) {
      var archiveLabel = existing.status === 'archived' ? 'Restore' : 'Archive';
      h += '<button type="button" class="sc-btn sc-btn-del" id="roleArchiveBtn">' + archiveLabel + '</button>';
    }
    h += '<button type="button" class="sc-btn" id="roleCancelBtn">Cancel</button>';
    h += '<button type="submit" class="btn btn-primary" id="roleSaveBtn">' + (isNew ? 'Create' : 'Save') + '</button>';
    h += '</div>';
    h += '</div>';
    h += '</form>';
    h += '</div>';

    overlay.innerHTML = h;
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
    }
    overlay.querySelector('.role-edit-close').addEventListener('click', close);
    overlay.querySelector('#roleCancelBtn').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    var archiveBtn = overlay.querySelector('#roleArchiveBtn');
    if (archiveBtn) {
      archiveBtn.addEventListener('click', function () {
        var nextStatus = existing.status === 'archived' ? 'active' : 'archived';
        if (nextStatus === 'archived' && !confirm('Archive "' + existing.title + '"? It\'ll stay in the database but be hidden from the default list.')) return;
        saveRoleEdit(overlay, existing.id, { status: nextStatus }, close);
      });
    }

    overlay.querySelector('#roleEditForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(this);
      var dutiesRaw = String(fd.get('duties') || '');
      var payload = {
        title: String(fd.get('title') || '').trim(),
        job_length: String(fd.get('job_length') || '').trim(),
        committee: String(fd.get('committee') || '').trim(),
        category: fd.get('category') || 'committee_role',
        status: fd.get('status') || 'active',
        parent_role_id: fd.get('parent_role_id') ? parseInt(fd.get('parent_role_id'), 10) : null,
        display_order: parseInt(fd.get('display_order'), 10) || 0,
        overview: String(fd.get('overview') || '').trim(),
        duties: dutiesRaw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
        playbook: String(fd.get('playbook') || '').trim()
      };
      if (isNew) {
        payload.role_key = String(fd.get('role_key') || '').trim().toLowerCase();
        if (!payload.role_key || !payload.title) {
          showRoleEditErr(overlay, 'role_key and title are required');
          return;
        }
      }
      saveRoleEdit(overlay, existing.id, payload, close);
    });
  }

  function showRoleEditErr(overlay, msg) {
    var e = overlay.querySelector('#roleEditErr');
    if (!e) return;
    e.textContent = msg;
    e.style.display = '';
  }

  function saveRoleEdit(overlay, id, payload, onDone) {
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) { showRoleEditErr(overlay, 'Sign-in required'); return; }
    var url = '/api/cleaning?action=roles' + (id ? '&id=' + id : '');
    var method = id ? 'PATCH' : 'POST';
    var saveBtn = overlay.querySelector('#roleSaveBtn');
    if (saveBtn) saveBtn.disabled = true;
    fetch(url, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          showRoleEditErr(overlay, (res.data && res.data.error) || ('Save failed (' + res.status + ')'));
          if (saveBtn) saveBtn.disabled = false;
          return;
        }
        onDone();
        loadRolesManagerTree();
        if (typeof loadRolesManagerCount === 'function') loadRolesManagerCount();
      })
      .catch(function (err) {
        showRoleEditErr(overlay, 'Network error: ' + (err.message || 'unknown'));
        if (saveBtn) saveBtn.disabled = false;
      });
  }

  function showPmSubmissionsModal() {
    if (!personDetail || !personDetailCard) return;
    var h = '<button class="detail-close" aria-label="Close">&times;</button>';
    h += '<div class="elective-detail rd-modal pmrep-modal">';
    h += '<div class="pmrep-head">';
    h += '<h3 class="rd-title" style="margin:0;">PM Class Submissions</h3>';
    h += '<span class="pmrep-count" id="pmrep-count">—</span>';
    h += '</div>';
    h += '<p class="rd-subtitle">Approve to queue a submission for scheduling, or decline with a confirmation. The Schedule Builder still owns final session/hour placement.</p>';
    h += '<div class="pmrep-filters">';
    h += '<label>Status <select class="pmrep-f" data-filter="status">';
    h += '<option value="submitted">Submitted</option>';
    h += '<option value="drafted">Drafted</option>';
    h += '<option value="scheduled">Scheduled</option>';
    h += '<option value="declined">Declined</option>';
    h += '<option value="withdrawn">Withdrawn</option>';
    h += '<option value="all">All</option>';
    h += '</select></label>';
    h += '<label>Session <select class="pmrep-f" data-filter="session">';
    h += '<option value="all">Any</option>';
    h += '<option value="flexible">Flexible</option>';
    for (var s = 1; s <= 5; s++) h += '<option value="' + s + '">S' + s + '</option>';
    h += '</select></label>';
    h += '<label>Age <select class="pmrep-f" data-filter="age">';
    h += '<option value="all">Any</option>';
    h += '<option value="3-7">3–7</option>';
    h += '<option value="7-9">7–9</option>';
    h += '<option value="10-12">10–12</option>';
    h += '<option value="teens">Teens</option>';
    h += '</select></label>';
    h += '<label>Year <select class="pmrep-f" data-filter="school_year">';
    h += '<option value="2026-2027">2026–2027</option>';
    h += '<option value="2027-2028">2027–2028</option>';
    h += '</select></label>';
    h += '</div>';
    h += '<div id="pmrep-body"><p class="ws-empty">Loading submissions…</p></div>';
    h += '</div>';
    personDetailCard.innerHTML = h;
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    personDetailCard.querySelector('.detail-close').addEventListener('click', closeDetail);
    personDetail.addEventListener('click', function (e) { if (e.target === personDetail) closeDetail(); });
    loadPmSubmissionsReport();
  }

  // Lightweight count fetch used on workspace render to paint a "N pending"
  // pill next to the Submissions Report button without loading the full list.
  // Treasurer To Do widget — paints the pending-payment count pill.
  // Uses /api/tour?list=registrations (same endpoint as the Membership
  // Report) so we don't add a second route. Counts rows whose
  // payment_status is anything other than 'paid'.
  function loadTreasurerPendingCount() {
    var item = document.getElementById('ws-todo-pending-item');
    var pill = document.getElementById('ws-todo-pending-count');
    var label = document.getElementById('ws-todo-pending-label');
    if (!item) return;
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/tour?list=registrations', {
      headers: { 'Authorization': 'Bearer ' + cred }
    })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; })
          .catch(function () { return { ok: r.ok, status: r.status, data: null }; });
      })
      .then(function (res) {
        if (!res.ok) {
          var msg = (res.data && res.data.error) || ('HTTP ' + res.status);
          if (res.data && res.data.youAre) msg += ' (logged in as ' + res.data.youAre + ', expected ' + res.data.expected + ')';
          console.warn('[loadTreasurerPendingCount] ' + msg);
          item.hidden = true;
          recomputeTodoEmptyState();
          return;
        }
        var regs = Array.isArray(res.data && res.data.registrations) ? res.data.registrations : [];
        var pending = regs.filter(function (r) {
          return String(r.payment_status || '').toLowerCase() !== 'paid';
        }).length;
        if (pending > 0) {
          if (label) label.textContent = 'Pending Payment Registration' + (pending === 1 ? '' : 's');
          if (pill) pill.textContent = String(pending);
          item.hidden = false;
        } else {
          item.hidden = true;
        }
        recomputeTodoEmptyState();
      })
      .catch(function (err) { console.warn('[loadTreasurerPendingCount] network error:', err); });
  }

  function loadPmSubmissionsPendingCount() {
    var pill = document.getElementById('pmrep-pending-count');
    if (!pill) return;
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/curriculum?action=class-submissions&scope=all', {
      headers: { 'Authorization': 'Bearer ' + cred }
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        var subs = Array.isArray(data.submissions) ? data.submissions : [];
        // Cache so the modal can open instantly without a second fetch.
        _pmReportState.submissions = subs;
        _pmReportState.loaded = true;
        var year = _pmReportState.filters.school_year;
        var pending = subs.filter(function (s) {
          return s.status === 'submitted' && s.school_year === year;
        }).length;
        if (pending > 0) {
          pill.textContent = pending + ' new';
          pill.hidden = false;
        } else {
          pill.hidden = true;
        }
      })
      .catch(function () { /* silent — pill stays hidden */ });
  }

  function loadPmSubmissionsReport(forceRefetch) {
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    // Re-bind filter change handlers each render (elements get re-created).
    document.querySelectorAll('.pmrep-f').forEach(function (el) {
      var key = el.getAttribute('data-filter');
      if (!key) return;
      if (_pmReportState.filters[key] != null) el.value = _pmReportState.filters[key];
      if (el._pmrepWired) return;
      el._pmrepWired = true;
      el.addEventListener('change', function () {
        var k = this.getAttribute('data-filter');
        _pmReportState.filters[k] = this.value;
        renderPmSubmissionsReport();
      });
    });
    if (_pmReportState.loaded && !forceRefetch) {
      renderPmSubmissionsReport();
      return;
    }
    fetch('/api/curriculum?action=class-submissions&scope=all', {
      headers: { 'Authorization': 'Bearer ' + cred }
    })
      .then(function (r) {
        if (r.status === 403) throw new Error('Reviewer access only.');
        return r.json();
      })
      .then(function (data) {
        _pmReportState.submissions = Array.isArray(data.submissions) ? data.submissions : [];
        _pmReportState.loaded = true;
        renderPmSubmissionsReport();
      })
      .catch(function (err) {
        var body = document.getElementById('pmrep-body');
        if (body) body.innerHTML = '<p class="ws-empty">' + escapeHtml(err.message || 'Could not load submissions.') + '</p>';
      });
  }

  function pmrepFormatHourPrefs(arr) {
    if (!arr || arr.length === 0) return '—';
    return arr.map(function (h) {
      if (h === 'first')        return 'PM1';
      if (h === 'last')         return 'PM2';
      if (h === 'flexible')     return 'Flex';
      if (h === '2hr-required') return '2-hr req';
      if (h === '2hr-optional') return '2-hr opt';
      return h;
    }).join(', ');
  }

  function pmrepFormatSessions(arr) {
    if (!arr || arr.length === 0) return '—';
    return arr.map(function (p) {
      return String(p) === 'flexible' ? 'Flex' : 'S' + p;
    }).join(', ');
  }

  function renderPmSubmissionsReport() {
    var body = document.getElementById('pmrep-body');
    var countEl = document.getElementById('pmrep-count');
    if (!body) return;

    var f = _pmReportState.filters;
    var all = _pmReportState.submissions;
    var filtered = all.filter(function (s) {
      if (f.status !== 'all' && s.status !== f.status) return false;
      if (f.school_year !== 'all' && s.school_year !== f.school_year) return false;
      if (f.session !== 'all') {
        var prefs = s.session_preferences || [];
        if (!prefs.some(function (p) { return String(p) === f.session; })) return false;
      }
      if (f.age !== 'all') {
        var ages = (s.age_groups || []).map(function (a) { return String(a).toLowerCase(); });
        if (ages.indexOf(f.age) === -1) return false;
      }
      return true;
    });

    if (countEl) {
      countEl.textContent = filtered.length === all.length
        ? filtered.length + ' submission' + (filtered.length === 1 ? '' : 's')
        : filtered.length + ' of ' + all.length;
    }

    if (filtered.length === 0) {
      body.innerHTML = '<p class="ws-empty">No submissions match these filters.</p>';
      return;
    }

    var h = '<div class="pmrep-tbl-scroll"><table class="pmrep-tbl">';
    h += '<thead><tr>';
    h += '<th>Class</th><th>Submitter</th><th>Sessions</th><th>Hour</th><th>Ages</th><th>Max</th><th>Status</th><th class="pmrep-actions-col">Actions</th>';
    h += '</tr></thead><tbody>';
    filtered.forEach(function (s) {
      h += '<tr data-sub-id="' + s.id + '">';
      h += '<td class="pmrep-class-cell"><strong>' + escapeHtml(s.class_name) + '</strong>';
      if (s.description) {
        var snippet = String(s.description).slice(0, 120);
        h += '<div class="pmrep-class-desc">' + escapeHtml(snippet) + (String(s.description).length > 120 ? '…' : '') + '</div>';
      }
      h += '</td>';
      h += '<td>' + escapeHtml(s.submitted_by_name || s.submitted_by_email) + '</td>';
      h += '<td>' + escapeHtml(pmrepFormatSessions(s.session_preferences)) + '</td>';
      h += '<td>' + escapeHtml(pmrepFormatHourPrefs(s.hour_preference)) + '</td>';
      h += '<td>' + (s.age_groups || []).map(escapeHtml).join(', ') + '</td>';
      h += '<td>' + (s.max_students || '—') + '</td>';
      h += '<td><span class="pmrep-status pmrep-status-' + s.status + '">' + s.status + '</span></td>';
      h += '<td class="pmrep-actions">';
      if (s.status === 'submitted') {
        h += '<button class="sc-btn pmrep-btn pmrep-approve-btn" data-sub-id="' + s.id + '" title="Queue for scheduling (status → drafted)">✓ Approve</button>';
        h += '<button class="sc-btn sc-btn-del pmrep-btn pmrep-decline-btn" data-sub-id="' + s.id + '" title="Decline this submission">✗ Decline</button>';
      } else if (s.status === 'declined' || s.status === 'withdrawn') {
        h += '<button class="sc-btn pmrep-btn pmrep-requeue-btn" data-sub-id="' + s.id + '" title="Send back to Submitted">↩ Re-queue</button>';
      } else {
        h += '<span class="pmrep-schedule-note">Use Schedule Builder</span>';
      }
      h += '</td>';
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    body.innerHTML = h;

    // Wire per-row action buttons.
    body.querySelectorAll('.pmrep-approve-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { pmReportAction(this.getAttribute('data-sub-id'), 'drafted', 'approve'); });
    });
    body.querySelectorAll('.pmrep-decline-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('Decline this submission? The submitter will see "Declined" on their dashboard.')) return;
        pmReportAction(this.getAttribute('data-sub-id'), 'declined', 'decline');
      });
    });
    body.querySelectorAll('.pmrep-requeue-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { pmReportAction(this.getAttribute('data-sub-id'), 'submitted', 're-queue'); });
    });
  }

  function pmReportAction(subId, newStatus, actionLabel) {
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/curriculum?action=class-submission&review=1&id=' + subId, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    })
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.error || 'Request failed (' + r.status + ')');
          return d;
        });
      })
      .then(function () {
        loadPmSubmissionsReport(true); // force refetch — list changes after action
        // Keep the workspace-card "N new" pill in sync with the server.
        if (typeof loadPmSubmissionsPendingCount === 'function') loadPmSubmissionsPendingCount();
      })
      .catch(function (err) {
        alert('Could not ' + actionLabel + ': ' + (err.message || 'unknown error'));
      });
  }

  function showScheduleBuilder() {
    if (document.getElementById('sbOverlay')) return;
    var html = '<div class="sb-overlay" id="sbOverlay">';
    html += '<div class="sb-panel" role="dialog" aria-modal="true" aria-label="PM Class Schedule Builder">';
    html += '<button class="detail-close" id="sbCloseBtn" aria-label="Close">&times;</button>';
    html += '<div class="sb-header">';
    html += '<h3 style="margin:0;">PM Class Schedule Builder</h3>';
    html += '<label class="sb-year-label">School Year ';
    html += '<select id="sbYearSelect" class="cl-input" style="display:inline-block;width:auto;margin-left:6px;">';
    html += '<option value="2026-2027">2026–2027</option>';
    html += '<option value="2027-2028">2027–2028</option>';
    html += '</select></label>';
    html += '</div>';
    html += '<div class="sb-body" id="sbBody"><em style="color:var(--color-text-light);">Loading submissions…</em></div>';
    html += '</div></div>';

    document.body.insertAdjacentHTML('beforeend', html);
    document.body.style.overflow = 'hidden';
    var overlay = document.getElementById('sbOverlay');
    document.getElementById('sbCloseBtn').addEventListener('click', closeScheduleBuilder);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeScheduleBuilder(); });
    document.getElementById('sbYearSelect').value = scheduleBuilderState.schoolYear;
    document.getElementById('sbYearSelect').addEventListener('change', function () {
      scheduleBuilderState.schoolYear = this.value;
      loadScheduleBuilder();
    });
    loadScheduleBuilder();
  }

  function closeScheduleBuilder() {
    var ov = document.getElementById('sbOverlay');
    if (ov) ov.remove();
    document.body.style.overflow = '';
  }

  function loadScheduleBuilder() {
    var cred = localStorage.getItem('rw_google_credential');
    if (!cred) return;
    var body = document.getElementById('sbBody');
    if (body) body.innerHTML = '<em style="color:var(--color-text-light);">Loading submissions…</em>';
    fetch('/api/curriculum?action=class-submissions&scope=all', {
      headers: { 'Authorization': 'Bearer ' + cred }
    })
    .then(function (r) {
      if (r.status === 403) throw new Error('You don\'t have reviewer access.');
      return r.json();
    })
    .then(function (data) {
      var all = Array.isArray(data.submissions) ? data.submissions : [];
      scheduleBuilderState.submissions = all.filter(function (s) {
        return s.school_year === scheduleBuilderState.schoolYear;
      });
      scheduleBuilderState.loaded = true;
      renderScheduleBuilder();
    })
    .catch(function (err) {
      if (body) body.innerHTML = '<em style="color:var(--color-coral);">' + (err.message || 'Could not load submissions.') + '</em>';
    });
  }

  function renderScheduleBuilder() {
    var body = document.getElementById('sbBody');
    if (!body) return;
    var sess = scheduleBuilderState.session;

    // Session pager local to the builder so it doesn't collide with
    // sessionTabView / cleaningTabView used elsewhere.
    var html = '<div class="session-pager" style="margin:0 0 14px;">';
    html += sess > 1
      ? '<button class="session-pager-btn sb-sess-btn" data-sess="' + (sess - 1) + '">&laquo; Session ' + (sess - 1) + '</button>'
      : '<span class="session-pager-btn session-pager-disabled">&laquo;</span>';
    html += '<span class="session-pager-current' + (sess === currentSession ? ' session-pager-active' : '') + '">';
    html += 'Session ' + sess;
    if (sess === currentSession) html += ' <span class="session-pager-now">Current</span>';
    html += '</span>';
    html += sess < 5
      ? '<button class="session-pager-btn sb-sess-btn" data-sess="' + (sess + 1) + '">Session ' + (sess + 1) + ' &raquo;</button>'
      : '<span class="session-pager-btn session-pager-disabled">&raquo;</span>';
    html += '</div>';

    // Filter scheduled / drafted classes for this session.
    var classesInSession = scheduleBuilderState.submissions.filter(function (s) {
      return (s.status === 'scheduled' || s.status === 'drafted')
          && s.scheduled_session === sess;
    });

    // Grid header
    html += '<div class="sb-grid">';
    html += '<div class="sb-grid-head sb-grid-rowhead"></div>';
    SCHEDULE_HOURS.forEach(function (h) {
      var label = h === 'PM1' ? 'PM1 · 1:00–1:55' : 'PM2 · 2:00–2:55';
      html += '<div class="sb-grid-head">' + label + '</div>';
    });

    // Grid body
    SCHEDULE_SECTIONS.forEach(function (section) {
      html += '<div class="sb-grid-rowhead"><strong>' + escClsHtml(section.label) + '</strong>';
      html += '<div class="sb-grid-rowhead-groups">' + section.groups.map(function (g) { return AGE_GROUP_LABELS[g] || g; }).join(' · ') + '</div>';
      html += '</div>';

      SCHEDULE_HOURS.forEach(function (hour) {
        var inCell = classesInSession.filter(function (c) {
          if (c.scheduled_age_range !== section.label) return false;
          if (c.scheduled_hour === 'both') return true;
          return c.scheduled_hour === hour;
        });
        var count = inCell.length;
        var marker = count >= 3 ? '🟢' : count === 2 ? '🟡' : '🔴';
        html += '<div class="sb-cell" data-section="' + section.id + '" data-hour="' + hour + '">';
        html += '<div class="sb-cell-head"><span class="sb-cell-marker">' + marker + '</span><span class="sb-cell-count">' + count + ' class' + (count === 1 ? '' : 'es') + '</span></div>';
        inCell.forEach(function (c) {
          var bothBadge = c.scheduled_hour === 'both' ? ' <span class="sb-both-badge">Both</span>' : '';
          var draftBadge = c.status === 'drafted' ? ' <span class="sb-draft-badge">Draft</span>' : '';
          html += '<div class="sb-cell-class" data-sub-id="' + c.id + '">';
          html += '<strong>' + escClsHtml(c.class_name) + '</strong>' + bothBadge + draftBadge;
          html += '<div class="sb-cell-class-teacher">' + escClsHtml(c.submitted_by_name || c.submitted_by_email) + '</div>';
          html += '</div>';
        });
        html += '<button class="sb-cell-add" data-section="' + section.id + '" data-hour="' + hour + '">+ Add</button>';
        html += '</div>';
      });
    });
    html += '</div>';

    // Footer — unscheduled queue
    var unscheduled = scheduleBuilderState.submissions.filter(function (s) {
      return s.status === 'submitted';
    });
    html += '<div class="sb-inbox-note">';
    html += '<strong>Inbox:</strong> ' + unscheduled.length + ' submission' + (unscheduled.length === 1 ? '' : 's') + ' waiting to be drafted / scheduled. Click + Add in any cell to pull from the inbox.';
    html += '</div>';

    body.innerHTML = html;

    // Wire pager
    body.querySelectorAll('.sb-sess-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        scheduleBuilderState.session = parseInt(btn.getAttribute('data-sess'), 10);
        renderScheduleBuilder();
      });
    });

    // Wire + Add buttons
    body.querySelectorAll('.sb-cell-add').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var sectionId = btn.getAttribute('data-section');
        var hour = btn.getAttribute('data-hour');
        showSchedulePicker(sectionId, hour);
      });
    });

    // Wire class-item clicks → edit / unschedule modal
    body.querySelectorAll('.sb-cell-class').forEach(function (el) {
      el.addEventListener('click', function () {
        var subId = parseInt(el.getAttribute('data-sub-id'), 10);
        showScheduleEntryEditor(subId);
      });
    });
  }

  // Picker modal: lists submissions that match the cell's age section, plus
  // an "All other submissions" expander. Clicking "Assign here" PATCHes the
  // submission into this cell with status='scheduled'.
  function showSchedulePicker(sectionId, hour) {
    var section = SCHEDULE_SECTIONS.filter(function (s) { return s.id === sectionId; })[0];
    if (!section) return;
    if (document.getElementById('sbPickerOverlay')) return;

    var sess = scheduleBuilderState.session;
    var pool = scheduleBuilderState.submissions.filter(function (s) {
      return s.status === 'submitted';
    });
    function matchesSection(s) {
      return (s.age_groups || []).some(function (g) { return section.matches.indexOf(g) !== -1; });
    }
    function matchesSession(s) {
      var prefs = s.session_preferences || [];
      return prefs.indexOf(String(sess)) !== -1 || prefs.indexOf('flexible') !== -1;
    }
    function matchesHour(s) {
      var prefs = s.hour_preference || [];
      if (prefs.indexOf('flexible') !== -1) return true;
      if (prefs.indexOf('2hr-required') !== -1 || prefs.indexOf('2hr-optional') !== -1) return true;
      if (hour === 'PM1') return prefs.indexOf('first') !== -1;
      if (hour === 'PM2') return prefs.indexOf('last') !== -1;
      return false;
    }

    var matched = pool.filter(function (s) { return matchesSection(s) && matchesSession(s) && matchesHour(s); });
    var others  = pool.filter(function (s) { return matched.indexOf(s) === -1; });

    function renderSubRow(s) {
      var ages = prettyAgesClient(s.age_groups, s.age_groups_other);
      var hourPrefs = (s.hour_preference || []).map(function (h) { return HOUR_PREF_LABELS[h] || h; }).join(', ');
      var sessionPrefs = (s.session_preferences || []).map(function (x) { return x === 'flexible' ? 'flexible' : 'S' + x; }).join(', ');
      return '<li class="sb-pick-row" data-sub-id="' + s.id + '">'
        + '<div class="sb-pick-row-main">'
        +   '<strong>' + escClsHtml(s.class_name) + '</strong>'
        +   '<div class="sb-pick-row-meta">'
        +     '<span>' + escClsHtml(s.submitted_by_name || s.submitted_by_email) + '</span>'
        +     '<span>Ages: ' + escClsHtml(ages) + '</span>'
        +     '<span>Hours: ' + escClsHtml(hourPrefs) + '</span>'
        +     '<span>Sessions: ' + escClsHtml(sessionPrefs) + '</span>'
        +   '</div>'
        +   '<p class="sb-pick-row-desc">' + escClsHtml((s.description || '').slice(0, 200)) + (s.description && s.description.length > 200 ? '…' : '') + '</p>'
        + '</div>'
        + '<div class="sb-pick-row-actions">'
        +   '<button class="btn btn-primary sb-pick-assign" data-sub-id="' + s.id + '" style="padding:6px 14px;font-size:0.85rem;">Assign here</button>'
        + '</div>'
        + '</li>';
    }

    var html = '<div class="sb-overlay" id="sbPickerOverlay" style="z-index:10000;">';
    html += '<div class="sb-panel sb-panel-picker" role="dialog" aria-modal="true">';
    html += '<button class="detail-close" id="sbPickerCloseBtn" aria-label="Close">&times;</button>';
    html += '<h3 style="margin:0 0 0.25rem;">Assign to ' + escClsHtml(section.label) + ' · ' + hour + ' · Session ' + sess + '</h3>';
    html += '<p class="cls-help" style="margin:0 0 1rem;">Showing submissions that fit this age section + session + hour. Expand "Other submissions" to broaden.</p>';

    if (matched.length === 0 && others.length === 0) {
      html += '<p style="color:var(--color-text-light);">No submissions in the inbox yet. Check back after members submit.</p>';
    } else {
      html += '<h4 class="sb-pick-section-title">Matches (' + matched.length + ')</h4>';
      if (matched.length === 0) {
        html += '<p style="color:var(--color-text-light);font-size:0.9rem;">No submissions match this cell perfectly. Expand below to see all other waiting submissions.</p>';
      } else {
        html += '<ul class="sb-pick-list">' + matched.map(renderSubRow).join('') + '</ul>';
      }
      html += '<details style="margin-top:1rem;"><summary style="cursor:pointer;font-weight:600;color:var(--color-primary);">Other submissions (' + others.length + ')</summary>';
      html += '<ul class="sb-pick-list">' + others.map(renderSubRow).join('') + '</ul>';
      html += '</details>';
    }

    html += '<div class="cls-actions"><button type="button" class="sc-btn" id="sbPickerCancelBtn">Close</button></div>';
    html += '</div></div>';

    document.body.insertAdjacentHTML('beforeend', html);
    var overlay = document.getElementById('sbPickerOverlay');
    function close() { overlay.remove(); }
    document.getElementById('sbPickerCloseBtn').addEventListener('click', close);
    document.getElementById('sbPickerCancelBtn').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    overlay.querySelectorAll('.sb-pick-assign').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var subId = parseInt(btn.getAttribute('data-sub-id'), 10);
        // 2-hour classes always span both cells, so auto-set 'both' when the
        // submission's hour preference requires it.
        var sub = scheduleBuilderState.submissions.filter(function (s) { return s.id === subId; })[0];
        var scheduledHour = hour;
        if (sub && (sub.hour_preference || []).indexOf('2hr-required') !== -1) scheduledHour = 'both';
        btn.disabled = true; btn.textContent = 'Assigning…';
        patchReviewAction(subId, {
          status: 'scheduled',
          scheduled_session: scheduleBuilderState.session,
          scheduled_hour: scheduledHour,
          scheduled_age_range: section.label,
          scheduled_room: sub ? (sub.scheduled_room || '') : '',
          reviewer_notes: sub ? (sub.reviewer_notes || '') : ''
        }).then(function () {
          close();
          loadScheduleBuilder();
        }).catch(function (err) {
          btn.disabled = false; btn.textContent = 'Assign here';
          alert('Could not assign: ' + (err.message || 'unknown error'));
        });
      });
    });
  }

  // Small client-side mirror of the API prettyAges — used in the picker rows.
  function prettyAgesClient(a, other) {
    var parts = (a || []).map(function (v) { return AGE_GROUP_LABELS[v] || v; });
    if (other) parts.push(other);
    return parts.join(', ') || '—';
  }

  // Editor modal for a class already in the grid. Lets VP/PMA change hour,
  // age section, room, status, or unschedule back to the inbox.
  function showScheduleEntryEditor(subId) {
    var sub = scheduleBuilderState.submissions.filter(function (s) { return s.id === subId; })[0];
    if (!sub) return;
    if (document.getElementById('sbEditOverlay')) return;

    var sectionOptions = SCHEDULE_SECTIONS.map(function (sec) {
      var sel = sub.scheduled_age_range === sec.label ? ' selected' : '';
      return '<option value="' + escClsAttr(sec.label) + '"' + sel + '>' + escClsHtml(sec.label) + '</option>';
    }).join('');
    var hourOptions = ['PM1', 'PM2', 'both'].map(function (h) {
      return '<option value="' + h + '"' + (sub.scheduled_hour === h ? ' selected' : '') + '>' + h + '</option>';
    }).join('');
    var sessOptions = [1, 2, 3, 4, 5].map(function (s) {
      return '<option value="' + s + '"' + (sub.scheduled_session === s ? ' selected' : '') + '>Session ' + s + '</option>';
    }).join('');

    var html = '<div class="sb-overlay" id="sbEditOverlay" style="z-index:10000;">';
    html += '<div class="sb-panel sb-panel-edit" role="dialog" aria-modal="true">';
    html += '<button class="detail-close" id="sbEditCloseBtn" aria-label="Close">&times;</button>';
    html += '<h3 style="margin:0 0 0.25rem;">' + escClsHtml(sub.class_name) + '</h3>';
    html += '<p class="cls-help" style="margin:0 0 1rem;">Submitted by ' + escClsHtml(sub.submitted_by_name || sub.submitted_by_email) + ' · Current status: <strong>' + escClsHtml(sub.status) + '</strong></p>';

    html += '<div class="cls-field"><label class="cls-label">Session</label><select class="cl-input" id="sbEditSess">' + sessOptions + '</select></div>';
    html += '<div class="cls-field"><label class="cls-label">Hour</label><select class="cl-input" id="sbEditHour">' + hourOptions + '</select></div>';
    html += '<div class="cls-field"><label class="cls-label">Age section</label><select class="cl-input" id="sbEditAge">' + sectionOptions + '</select></div>';
    html += '<div class="cls-field"><label class="cls-label">Room (optional)</label><input class="cl-input" id="sbEditRoom" type="text" maxlength="100" value="' + escClsAttr(sub.scheduled_room || '') + '"></div>';
    html += '<div class="cls-field"><label class="cls-label">Reviewer notes (private)</label><textarea class="cl-input cls-textarea" id="sbEditNotes" rows="3" maxlength="2000">' + escClsHtml(sub.reviewer_notes || '') + '</textarea></div>';

    html += '<div id="sbEditError" class="cls-error" style="display:none;"></div>';

    html += '<div class="cls-actions" style="justify-content:space-between;flex-wrap:wrap;">';
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
    html += '<button type="button" class="sc-btn sc-btn-del" id="sbEditUnschedBtn">Send back to Inbox</button>';
    html += '<button type="button" class="sc-btn sc-btn-del" id="sbEditDeclineBtn">Decline</button>';
    html += '</div>';
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
    html += '<button type="button" class="sc-btn" id="sbEditCancelBtn">Cancel</button>';
    html += '<button type="button" class="sc-btn" id="sbEditDraftBtn">Save as Draft</button>';
    html += '<button type="button" class="btn btn-primary" id="sbEditScheduleBtn" style="padding:8px 16px;font-size:0.9rem;">Save as Scheduled</button>';
    html += '</div>';
    html += '</div>';

    html += '</div></div>';

    document.body.insertAdjacentHTML('beforeend', html);
    var overlay = document.getElementById('sbEditOverlay');
    function close() { overlay.remove(); }
    document.getElementById('sbEditCloseBtn').addEventListener('click', close);
    document.getElementById('sbEditCancelBtn').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    function currentForm() {
      return {
        scheduled_session: parseInt(document.getElementById('sbEditSess').value, 10),
        scheduled_hour: document.getElementById('sbEditHour').value,
        scheduled_age_range: document.getElementById('sbEditAge').value,
        scheduled_room: document.getElementById('sbEditRoom').value.trim(),
        reviewer_notes: document.getElementById('sbEditNotes').value
      };
    }
    function runPatch(overrides, actionLabel) {
      var errEl = document.getElementById('sbEditError');
      errEl.style.display = 'none';
      var payload = Object.assign({}, currentForm(), overrides);
      patchReviewAction(subId, payload).then(function () {
        close();
        loadScheduleBuilder();
      }).catch(function (err) {
        errEl.textContent = err.message || 'Could not ' + actionLabel + '.';
        errEl.style.display = '';
      });
    }

    document.getElementById('sbEditScheduleBtn').addEventListener('click', function () {
      runPatch({ status: 'scheduled' }, 'schedule');
    });
    document.getElementById('sbEditDraftBtn').addEventListener('click', function () {
      runPatch({ status: 'drafted' }, 'save draft');
    });
    document.getElementById('sbEditUnschedBtn').addEventListener('click', function () {
      if (!confirm('Send this back to the inbox? It becomes unscheduled until you re-assign it.')) return;
      runPatch({ status: 'submitted', scheduled_session: null, scheduled_hour: null, scheduled_age_range: '', scheduled_room: '' }, 'unschedule');
    });
    document.getElementById('sbEditDeclineBtn').addEventListener('click', function () {
      if (!confirm('Decline this submission? The submitter will see "Declined" on their dashboard.')) return;
      runPatch({ status: 'declined' }, 'decline');
    });
  }

  function patchReviewAction(subId, payload) {
    var cred = localStorage.getItem('rw_google_credential');
    return fetch('/api/curriculum?action=class-submission&review=1&id=' + subId, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Request failed (' + r.status + ')');
        return d;
      });
    });
  }

  function getClassInfo(classKey) {
    // Get class details from schedule data
    var isPM = classKey.indexOf('PM:') === 0;
    var name = isPM ? classKey.slice(3) : classKey;
    var info = { name: name, isPM: isPM, time: '', room: '', teacher: '', assistants: [], ageRange: '', topic: '', students: [] };

    if (!isPM) {
      var cls = AM_CLASSES[name];
      if (cls) {
        info.ageRange = cls.ages || '';
        var sess = cls.sessions[currentSession];
        if (sess) {
          info.time = '10:00\u201312:00';
          info.room = sess.room || '';
          info.teacher = sess.teacher || '';
          info.assistants = sess.assistants || [];
          info.topic = sess.topic || '';
        }
      }
    } else {
      var electives = PM_ELECTIVES[currentSession] || [];
      for (var i = 0; i < electives.length; i++) {
        if (electives[i].name === name) {
          var elec = electives[i];
          info.time = elec.hour === 1 ? '1:00\u20131:55' : elec.hour === 2 ? '2:00\u20132:55' : '1:00\u20132:55';
          info.room = elec.room || '';
          info.teacher = elec.leader || '';
          info.assistants = elec.assistants || [];
          info.ageRange = elec.ageRange || '';
          info.topic = elec.description || '';
          info.students = elec.students || [];
          break;
        }
      }
    }
    return info;
  }

  function showClassPack(classKey, curriculumId) {
    var cred = localStorage.getItem('rw_google_credential');
    fetch('/api/curriculum?id=' + curriculumId, { headers: { 'Authorization': 'Bearer ' + cred } })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.curriculum) { alert('Could not load lesson plan.'); return; }
      var curr = data.curriculum;
      var info = getClassInfo(classKey);
      var sessInfo = SESSION_DATES[currentSession];
      var sessName = sessInfo ? sessInfo.name : 'Session ' + currentSession;

      openClassPackWindow(info, curr, sessName);
    });
  }

  function openClassPackWindow(info, curr, sessName) {
    function esc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    var css = [
      '@page { margin: 0.5in; }',
      '* { box-sizing: border-box; }',
      'body { font-family: Georgia, serif; color: #000; max-width: 7.5in; margin: 0 auto; padding: 0.25in; line-height: 1.45; }',
      'h1 { font-size: 20pt; margin: 0 0 2pt 0; }',
      'h2 { font-size: 14pt; margin: 14pt 0 6pt 0; padding-bottom: 3pt; border-bottom: 1.5pt solid #333; }',
      '.meta { color: #555; font-size: 10pt; margin-bottom: 4pt; }',
      '.class-header { background: #f5f5f5; border: 1.5pt solid #333; padding: 12pt 14pt; margin-bottom: 14pt; page-break-after: avoid; break-after: avoid; }',
      '.class-header h1 { border: none; padding: 0; }',
      '.class-detail { display: grid; grid-template-columns: 1fr 1fr; gap: 4pt 16pt; font-size: 10pt; margin-top: 6pt; }',
      '.class-detail dt { font-weight: 700; color: #555; }',
      '.class-detail dd { margin: 0; }',
      '.roster { margin-top: 8pt; font-size: 9pt; }',
      '.roster-title { font-weight: 700; font-size: 10pt; margin-bottom: 3pt; }',
      '.roster-list { columns: 3; column-gap: 12pt; list-style: none; padding: 0; margin: 0; }',
      '.roster-list li { margin-bottom: 2pt; }',
      '.overview { background: #f5f5f5; padding: 8pt 12pt; border-left: 3pt solid #333; font-size: 11pt; margin-bottom: 14pt; }',
      '.master { border: 1.5pt solid #333; padding: 10pt 14pt; margin-bottom: 16pt; page-break-inside: avoid; }',
      '.master h3 { font-size: 12pt; margin: 0 0 4pt 0; }',
      '.master .sub { font-size: 9pt; color: #555; font-style: italic; margin: 0 0 6pt 0; }',
      '.source-group { margin-bottom: 6pt; }',
      '.source-heading { font-size: 9pt; font-weight: 700; margin: 4pt 0 2pt 0; padding-bottom: 1pt; border-bottom: 0.5pt solid #999; }',
      '.master ul { columns: 2; column-gap: 18pt; list-style: none; padding: 0; margin: 0; }',
      '.master li { padding-left: 18pt; text-indent: -18pt; margin-bottom: 3pt; font-size: 10pt; line-height: 1.3; break-inside: avoid; }',
      '.master li::before { content: "\\2610  "; font-size: 12pt; }',
      '.lessons, .qty, .notes { color: #555; font-size: 9pt; }',
      '.lesson { border: 1pt solid #333; padding: 12pt 14pt; margin-bottom: 14pt; page-break-inside: avoid; }',
      '.lesson-header { display: flex; align-items: baseline; gap: 8pt; padding-bottom: 4pt; border-bottom: 1pt solid #333; margin-bottom: 8pt; }',
      '.lesson-num { background: #333; color: #fff; padding: 2pt 8pt; font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }',
      '.lesson-title { font-size: 13pt; font-weight: 700; }',
      '.lesson-overview { font-style: italic; color: #444; font-size: 10pt; margin: 0 0 8pt 0; }',
      '.section { margin-bottom: 8pt; font-size: 10pt; }',
      '.section h4 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 3pt 0; color: #000; }',
      '.section ul { list-style: none; padding: 0; margin: 0; }',
      '.section ul.checks li { padding-left: 18pt; text-indent: -18pt; margin-bottom: 3pt; }',
      '.section ul.checks li::before { content: "\\2610  "; font-size: 12pt; }',
      '.loc-group { margin-bottom: 4pt; }',
      '.loc-label { font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #555; margin: 4pt 0 1pt 0; }',
      '.steps { display: grid; grid-template-columns: 44pt 1fr 1fr; gap: 12pt; }',
      '.steps .header { font-weight: 700; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em; padding-bottom: 4pt; border-bottom: 1pt solid #333; }',
      '.steps .num { text-align: right; padding-right: 4pt; font-weight: 700; }',
      '.steps .cell { padding: 3pt 0; border-bottom: 0.5pt solid #ccc; font-size: 10pt; }',
      '.low-flag { display: inline-block; font-size: 11pt; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; padding: 5pt 14pt; border-radius: 999pt; margin-left: 10pt; line-height: 1; vertical-align: 1pt; background: #e07a2a; color: #fff; box-shadow: 0 1pt 2pt rgba(0,0,0,0.15); text-indent: 0; }',
      '.low-flag-empty { background: #c0392b; }',
      '@media print { .low-flag { background: transparent !important; color: #000; border: 0.5pt solid #000; box-shadow: none !important; } }',
      '@media print { .no-print { display: none; } }',
      '.no-print { text-align: center; padding: 10pt; background: #ffe; border-bottom: 1pt solid #ccc; margin: -0.25in -0.25in 12pt -0.25in; }',
      '.no-print button { font-size: 11pt; padding: 6pt 16pt; cursor: pointer; margin: 0 4pt; }'
    ].join('\n');

    var html = '<!doctype html><html><head><meta charset="utf-8"><title>Class Pack: ' + esc(info.name) + '</title><style>' + css + '</style></head><body>';

    // Resolve a "First Last" name to the allPeople entry so we can attach
    // pronouns / allergies to class-pack rosters. Tries the kid's actual
    // lastName first, then falls back to the family surname.
    function lookupPerson(fullName) {
      if (!fullName || !Array.isArray(allPeople)) return null;
      var parts = String(fullName).trim().split(/\s+/);
      if (parts.length === 0) return null;
      var first = parts[0];
      var last = parts.slice(1).join(' ');
      for (var i = 0; i < allPeople.length; i++) {
        var p = allPeople[i];
        if (p.name !== first) continue;
        if (!last) return p;
        if (p.lastName === last || p.family === last) return p;
      }
      return null;
    }

    function staffLine(name) {
      var p = lookupPerson(name);
      var url = getPhotoUrl(name, p ? p.email : '', p ? p.family : '');
      var imgHtml = '';
      if (url) {
        var hi = url.replace(/=s\d+-c/, '=s256-c');
        imgHtml = '<img src="' + esc(hi) + '" alt="' + esc(name) + '" style="width:20pt;height:20pt;border-radius:50%;object-fit:cover;vertical-align:-5pt;margin-right:4pt;">';
      }
      var pron = (p && p.pronouns) ? ' <span style="color:#555;font-style:italic;">(' + esc(p.pronouns) + ')</span>' : '';
      return imgHtml + esc(name) + pron;
    }

    // ── Class header ──
    html += '<div class="class-header">';
    html += '<h1>' + esc(info.name) + (info.ageRange ? ' <span style="font-size:12pt;color:#555;">(' + esc(info.ageRange) + ')</span>' : '') + '</h1>';
    html += '<div class="meta">' + esc(sessName) + '</div>';
    html += '<dl class="class-detail">';
    html += '<dt>Time</dt><dd>' + esc(info.time) + '</dd>';
    html += '<dt>Room</dt><dd>' + esc(info.room) + '</dd>';
    html += '<dt>Teacher</dt><dd>' + staffLine(info.teacher) + '</dd>';
    if (info.assistants.length) {
      html += '<dt>Assistants</dt><dd>' + info.assistants.map(staffLine).join(', ') + '</dd>';
    }
    if (info.topic) { html += '<dt>Topic</dt><dd>' + esc(info.topic) + '</dd>'; }
    html += '</dl>';

    // Student roster with pronouns inline + a highlighted allergy/medical
    // callout so teachers see it at a glance instead of scanning line by line.
    if (info.students && info.students.length > 0) {
      html += '<div class="roster"><div class="roster-title">Students (' + info.students.length + ')</div><ul class="roster-list">';
      var allergyCallouts = [];
      info.students.forEach(function (s) {
        var p = lookupPerson(s);
        var pron = p && p.pronouns ? ' <em style="color:#666;font-size:8.5pt;">(' + esc(p.pronouns) + ')</em>' : '';
        var ageTag = p && p.age ? ' <span style="color:#555;font-size:8.5pt;">· age ' + p.age + '</span>' : '';
        var noPhotoTag = p && p.photoConsent === false
          ? ' <strong style="color:#b3381a;font-size:8.5pt;">⛔ No Photos</strong>'
          : '';
        html += '<li>' + esc(s) + ageTag + pron + noPhotoTag + '</li>';
        if (p && p.allergies) allergyCallouts.push({ name: s, allergies: p.allergies });
      });
      html += '</ul></div>';
      if (allergyCallouts.length > 0) {
        html += '<div class="roster-alerts" style="margin-top:8pt;border:1pt solid #b3381a;background:#fdf2ef;padding:8pt 10pt;font-size:9.5pt;">';
        html += '<div style="font-weight:700;color:#b3381a;margin-bottom:3pt;">\u26A0 Allergy & Medical Alerts</div>';
        html += '<ul style="list-style:none;padding:0;margin:0;">';
        allergyCallouts.forEach(function (c) {
          html += '<li style="margin-bottom:2pt;"><strong>' + esc(c.name) + ':</strong> ' + esc(c.allergies) + '</li>';
        });
        html += '</ul></div>';
      }
    }
    html += '</div>';

    // ── Lesson plan ──
    if (curr) {

      // Master supply list
      var rows = aggregateSupplyRows(curr);
      if (rows.length > 0) {
        var groups = groupSupplyRowsByLocation(rows);
        html += '<div class="master"><h3>Master Supply List</h3><p class="sub">Everything needed across all lessons.</p>';
        groups.forEach(function (g) {
          html += '<div class="source-group"><div class="source-heading">' + esc(g.heading) + '</div><ul>';
          g.items.forEach(function (r) {
            var bits = [];
            if (r.qty) bits.push(esc(r.qty));
            if (r.unit === 'student') bits.push('per student');
            else if (r.unit === 'class') bits.push('per class');
            var qtyStr = bits.length ? ' <span class="qty">(' + bits.join(' ') + ')</span>' : '';
            var lessonsStr = ' <span class="lessons">\u00b7 L' + r.lessons.join(',') + '</span>';
            var notesStr = r.notes ? ' <span class="notes">\u2014 ' + esc(r.notes) + '</span>' : '';
            var flagStr = '';
            if (r.closet_needs_restock || r.closet_quantity_level === 'empty') flagStr = ' <span class="low-flag low-flag-empty">' + (r.closet_quantity_level === 'empty' ? 'Empty' : 'Low') + '</span>';
            else if (r.closet_quantity_level === 'low') flagStr = ' <span class="low-flag">Low</span>';
            html += '<li><strong>' + esc(r.name) + '</strong>' + flagStr + qtyStr + lessonsStr + notesStr + '</li>';
          });
          html += '</ul></div>';
        });
        html += '</div>';
      }

      // Each lesson
      (curr.lessons || []).forEach(function (ls) {
        html += '<div class="lesson">';
        html += '<div class="lesson-header"><span class="lesson-num">Lesson ' + ls.lesson_number + '</span>';
        if (ls.title) html += '<span class="lesson-title">' + esc(ls.title) + '</span>';
        html += '</div>';
        if (ls.overview) html += '<p class="lesson-overview">' + esc(ls.overview) + '</p>';

        if (ls.room_setup) {
          html += '<div class="section"><h4>Room setup</h4><p style="margin:0;">' + esc(ls.room_setup) + '</p></div>';
        }

        if (ls.supplies && ls.supplies.length) {
          html += '<div class="section"><h4>Supplies</h4>';
          var pGroups = groupLessonSuppliesByLocation(ls.supplies);
          pGroups.forEach(function (g) {
            html += '<div class="loc-group"><div class="loc-label">' + esc(g.heading) + '</div><ul class="checks">';
            g.items.forEach(function (s) {
              var line = '<strong>' + esc(s.item_name) + '</strong>';
              if (s.closet_needs_restock || s.closet_quantity_level === 'empty') {
                line += ' <span class="low-flag low-flag-empty">' + (s.closet_quantity_level === 'empty' ? 'Empty' : 'Low') + '</span>';
              } else if (s.closet_quantity_level === 'low') {
                line += ' <span class="low-flag">Low</span>';
              }
              var bits = [];
              if (s.qty) bits.push(esc(s.qty));
              if (s.qty_unit === 'student') bits.push('per student');
              else if (s.qty_unit === 'class') bits.push('per class');
              if (bits.length) line += ' <span class="qty">(' + bits.join(' ') + ')</span>';
              if (s.notes) line += ' <span class="notes">\u2014 ' + esc(s.notes) + '</span>';
              html += '<li>' + line + '</li>';
            });
            html += '</ul></div>';
          });
          html += '</div>';
        }

        var actArr = ls.activity || [];
        var insArr = ls.instruction || [];
        var maxSteps = Math.max(actArr.length, insArr.length);
        if (maxSteps > 0) {
          html += '<div class="section" style="margin-top:10pt;"><div class="steps">';
          html += '<div class="header">Steps</div><div class="header">Activity</div><div class="header">Leader notes</div>';
          for (var si = 0; si < maxSteps; si++) {
            var aText = actArr[si] || '';
            var iText = insArr[si] || '';
            if (!aText && !iText) continue;
            html += '<div class="cell num">' + (si + 1) + '.</div>';
            html += '<div class="cell">' + esc(aText) + '</div>';
            html += '<div class="cell">' + esc(iText) + '</div>';
          }
          html += '</div></div>';
        }

        if (ls.links && ls.links.length) {
          html += '<div class="section"><h4>References</h4><ul>';
          ls.links.forEach(function (l) {
            html += '<li><a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + esc(l.label || l.url) + '</a></li>';
          });
          html += '</ul></div>';
        }
        html += '</div>';
      });
    }

    html += '</body></html>';

    // Show the Class Pack in a preview modal first, so the teacher can
    // review before printing. The modal's "Print" button triggers the
    // hidden-iframe print flow; "Close" dismisses the preview.
    showClassPackPreview(info, html);
  }

  // In-page preview modal for the Class Pack. Renders the standalone
  // document inside an iframe so the rendered preview matches the printed
  // output exactly.
  function showClassPackPreview(info, docHtml) {
    // Tear down any prior preview
    var existing = document.getElementById('rw-classpack-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'rw-classpack-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9999',
      'background:rgba(0,0,0,0.6)',
      'display:flex', 'align-items:stretch', 'justify-content:center',
      'padding:1rem'
    ].join(';');

    // Panel uses position:relative so the unified .detail-actions and
    // .detail-close (top-right corner chrome) anchor correctly.
    var panel = document.createElement('div');
    panel.style.cssText = [
      'position:relative',
      'background:#fff', 'border-radius:8px',
      'box-shadow:0 12px 40px rgba(0,0,0,0.3)',
      'display:flex', 'flex-direction:column',
      'width:100%', 'max-width:960px', 'margin:auto', 'max-height:100%', 'overflow:hidden'
    ].join(';');

    var titleRow = document.createElement('div');
    titleRow.style.cssText = [
      'padding:0.85rem 1rem 0.75rem',
      'border-bottom:1px solid rgba(74,45,58,0.12)',
      'padding-right:140px'            // reserve room for .detail-actions + .detail-close
    ].join(';');
    titleRow.innerHTML =
      '<strong style="font-family:\'Playfair Display\',Georgia,serif;color:#4a2d3a;font-size:1.05rem;">' +
        'Class Pack &mdash; ' + (info && info.name ? info.name : '') +
      '</strong>';

    var actions = document.createElement('div');
    actions.className = 'detail-actions';
    actions.innerHTML = '<button type="button" class="sc-btn" id="rwCpPrint">\u2399 Print</button>';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'detail-close';
    closeBtn.id = 'rwCpClose';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '&times;';

    var iframeWrap = document.createElement('div');
    iframeWrap.style.cssText = 'flex:1;overflow:auto;background:#f5f1eb;';
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;height:100%;min-height:60vh;border:0;background:#fff;';
    iframe.setAttribute('title', 'Class Pack preview');
    iframeWrap.appendChild(iframe);

    panel.appendChild(titleRow);
    panel.appendChild(actions);
    panel.appendChild(closeBtn);
    panel.appendChild(iframeWrap);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Write the doc into the iframe so the preview matches print output.
    try {
      var doc = iframe.contentDocument || iframe.contentWindow.document;
      doc.open();
      doc.write(docHtml);
      doc.close();
    } catch (e) {
      console.error('Class Pack preview write failed', e);
    }

    function closePreview() { overlay.remove(); }

    document.getElementById('rwCpClose').addEventListener('click', closePreview);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closePreview(); });
    document.getElementById('rwCpPrint').addEventListener('click', function () {
      openPrintIframe(docHtml);
    });
  }

  // Shared print-iframe helper. Used by the Class Pack and duty-detail
  // print. Writes the doc via document.write (more reliable onload firing
  // than srcdoc in Chromium) and falls back to a timeout if onload never
  // fires — that way silent failures still produce a print dialog.
  function openPrintIframe(docHtml) {
    var iframe = document.getElementById('rw-print-iframe');
    if (iframe) iframe.remove();
    iframe = document.createElement('iframe');
    iframe.id = 'rw-print-iframe';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    // Append first so contentDocument exists and can be written to.
    document.body.appendChild(iframe);

    var printed = false;
    function doPrint() {
      if (printed) return;
      printed = true;
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (e) {
        console.error('openPrintIframe: print threw', e);
        alert('Print failed: ' + (e && e.message || e));
      }
    }

    iframe.onload = doPrint;

    try {
      var doc = iframe.contentDocument || iframe.contentWindow.document;
      doc.open();
      doc.write(docHtml);
      doc.close();
    } catch (e) {
      console.error('openPrintIframe: write threw', e);
      alert('Could not prepare the print document: ' + (e && e.message || e));
      iframe.remove();
      return;
    }

    // Safety net: some environments never fire onload for same-origin
    // document.write into a fresh iframe. Fire anyway after 600ms so users
    // always get a print dialog. Fonts may still be loading, but the
    // content will be present.
    setTimeout(doPrint, 600);
  }

  function showAttachPicker(classKey) {
    // Load curriculum list if not cached
    var cred = localStorage.getItem('rw_google_credential');
    fetch('/api/curriculum', { headers: { 'Authorization': 'Bearer ' + cred } })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var curricula = data.curricula || [];
      var displayKey = classKey.replace('PM:', '') + ' \u2014 Session ' + currentSession;

      var html = '<div class="absence-overlay" id="attachPickerOverlay"><div class="absence-modal">';
      html += '<button class="detail-close absence-close" id="attachPickerClose">&times;</button>';
      html += '<h3>Attach Lesson Plan</h3>';
      html += '<p style="font-size:0.82rem;color:var(--color-text-light);margin-bottom:0.75rem;">Select a lesson plan for <strong>' + displayKey + '</strong></p>';
      html += '<input class="cl-input" id="attachPickerSearch" placeholder="Search plans..." style="margin-bottom:0.75rem;">';
      html += '<div id="attachPickerList" class="attach-picker-list">';
      curricula.forEach(function (c) {
        html += '<button class="attach-picker-item" data-curriculum-id="' + c.id + '">';
        html += '<strong>' + c.title + '</strong>';
        if (c.subject) html += ' <span class="attach-picker-subject">' + c.subject + '</span>';
        html += '<br><span class="attach-picker-meta">' + c.lesson_count + ' lesson' + (c.lesson_count === 1 ? '' : 's') + ' \u00b7 by ' + (c.author_name || c.author_email) + '</span>';
        html += '</button>';
      });
      if (curricula.length === 0) html += '<p style="color:var(--color-text-light);text-align:center;padding:1rem;">No lesson plans yet.</p>';
      html += '</div>';
      html += '<div style="margin-top:0.75rem;text-align:center;">';
      html += '<button class="btn btn-primary btn-sm" id="attachPickerCreate">Create New Plan</button>';
      html += '</div>';
      html += '</div></div>';

      document.body.insertAdjacentHTML('beforeend', html);
      var overlay = document.getElementById('attachPickerOverlay');

      document.getElementById('attachPickerClose').addEventListener('click', function () { overlay.remove(); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

      // Search filter
      document.getElementById('attachPickerSearch').addEventListener('input', function () {
        var q = this.value.toLowerCase();
        overlay.querySelectorAll('.attach-picker-item').forEach(function (item) {
          var text = item.textContent.toLowerCase();
          item.style.display = text.indexOf(q) !== -1 ? '' : 'none';
        });
      });

      // Attach on click
      overlay.querySelectorAll('.attach-picker-item').forEach(function (item) {
        item.addEventListener('click', function () {
          var currId = parseInt(item.getAttribute('data-curriculum-id'), 10);
          item.disabled = true;
          fetch('/api/curriculum?action=link', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_number: currentSession, class_key: classKey, curriculum_id: currId })
          }).then(function (r) { return r.json(); }).then(function (res) {
            if (res.error) { alert('Error: ' + res.error); item.disabled = false; return; }
            overlay.remove();
            loadClassLinks();
          });
        });
      });

      // Create new plan
      document.getElementById('attachPickerCreate').addEventListener('click', function () {
        overlay.remove();
        // Store the class key so the editor can auto-link after save
        sessionStorage.setItem('rw_pending_class_link', classKey);
        // Open curriculum library and start new
        var currBtn = document.getElementById('classIdeasBtn');
        if (currBtn) currBtn.click();
        setTimeout(function () {
          if (typeof startNewCurriculum === 'function') startNewCurriculum();
        }, 300);
      });
    });
  }

  function initAbsenceCoverageSystem() {
    var bellBtn = document.getElementById('notifBellBtn');
    if (bellBtn) {
      bellBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (notifState.dropdownOpen) {
          closeNotifDropdown();
        } else {
          // Refresh before showing so the user isn't staring at stale state.
          loadNotifications();
          notifState.dropdownOpen = true;
          renderNotifDropdown();
        }
      });
    }
    var emiBtn = document.getElementById('editMyInfoNavBtn');
    if (emiBtn && !emiBtn._rwWired) {
      emiBtn.addEventListener('click', function () { showEditMyInfo(); });
      emiBtn._rwWired = true;
    }
    loadCoverageBoard();
    loadClassLinks();
    loadMyClassSubmissions();
    loadNotifications();
    setInterval(loadNotifications, 60000);
    // Re-check notifications when the tab becomes visible again so users
    // returning after a break see the current state instead of waiting up
    // to a full polling interval.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') loadNotifications();
    });
    initPushSubscription();
  }

  // ──────────────────────────────────────────────
  // Edit My Info — self-service profile overlay
  // ──────────────────────────────────────────────
  // Lets a signed-in member edit phone, address, per-parent pronouns+photo,
  // per-kid birthday/pronouns/allergies/schedule/photo, and placement notes.
  // Photos are resized client-side to ~512 px JPEG, uploaded to Vercel Blob
  // via /api/tour kind=profile-photo, then saved as part of the profile POST.
  function showEditMyInfo() {
    if (!personDetail || !personDetailCard) return;
    var email = getActiveEmail();
    if (!email) { alert('Please sign in to edit your info.'); return; }
    var fam = null;
    for (var i = 0; i < FAMILIES.length; i++) {
      if (familyMatchesEmail(FAMILIES[i], email)) { fam = FAMILIES[i]; break; }
    }
    if (!fam) {
      alert('Could not find your family. Contact communications@rootsandwingsindy.com for help.');
      return;
    }

    // Split a parent's stored name into first + last when the explicit
    // fields aren't yet populated. Heuristic: last whitespace-separated
    // word becomes last_name; everything before it becomes first_name. A
    // single-word name (e.g. "Jessica") falls back to "first only", with
    // last_name empty (display path will use family_name as the fallback).
    function splitName(fullName) {
      var parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return { first: '', last: '' };
      if (parts.length === 1) return { first: parts[0], last: '' };
      return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
    }

    var parentSeed;
    if (Array.isArray(fam.parentInfo) && fam.parentInfo.length) {
      parentSeed = fam.parentInfo.map(function (p, idx) {
        var split = (p.firstName || p.lastName)
          ? { first: p.firstName || '', last: p.lastName || '' }
          : splitName(p.name);
        return {
          name: p.name || '',
          first_name: split.first,
          last_name: split.last,
          pronouns: p.pronouns || '',
          photo_url: p.photoUrl || '',
          photo_consent: p.photoConsent !== false,
          role: p.role || (idx === 0 ? 'mlc' : (idx === 1 ? 'blc' : 'parent')),
          email: p.email || '',
          personal_email: p.personalEmail || '',
          phone: p.phone || '',
          _queuedPhoto: null
        };
      });
    } else {
      parentSeed = String(fam.parents || '').split(/\s*&\s*/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (n, idx) {
        var split = splitName(n);
        return {
          name: n,
          first_name: split.first,
          last_name: split.last,
          pronouns: (fam.parentPronouns && fam.parentPronouns[n]) || '',
          photo_url: '',
          photo_consent: true,
          role: idx === 0 ? 'mlc' : (idx === 1 ? 'blc' : 'parent'),
          email: '',
          personal_email: '',
          phone: '',
          _queuedPhoto: null
        };
      });
    }
    if (parentSeed.length === 0) parentSeed.push({ name: '', first_name: '', last_name: '', pronouns: '', photo_url: '', photo_consent: true, role: 'mlc', email: '', personal_email: '', phone: '', _queuedPhoto: null });

    var state = {
      family_email: fam.email,
      // Seed from the DB-corrected display name when present so a compound
      // surname (Aimee O'Connor Gading) appears correctly in the form, not
      // the sheet-parsed last word (Gading).
      family_name: fam.displayName || fam.name,
      phone: fam.phone || '',
      address: fam.address || '',
      parents: parentSeed,
      kids: (fam.kids || []).map(function (k) {
        return {
          name: k.name || '',
          // Per-kid last name. Empty in form = use family last name in display.
          // Useful for kids who use a different surname than the family unit.
          last_name: k.lastName && k.lastName !== fam.name ? k.lastName : '',
          birth_date: k.birthDate || '',
          pronouns: k.pronouns || '',
          allergies: k.allergies || '',
          schedule: k.schedule || 'all-day',
          photo_url: k.photoUrl || '',
          photo_consent: k.photo_consent !== false,
          _queuedPhoto: null
        };
      })
    };

    function thumbHtml(p, initial, opts) {
      var src = p._queuedPhoto || p.photo_url || '';
      // Fallback: show the existing Workspace photo so people see what they
      // currently have in the directory instead of a blank initial. If they
      // don't upload a new photo, we DON'T save the Workspace URL to the DB
      // (those rotate) — the directory keeps reading Workspace via getPhotoUrl.
      if (!src && opts && opts.wsFallback) {
        var wsUrl = getPhotoUrl(p.name || '', state.family_email, state.family_name);
        if (wsUrl) src = wsUrl.replace(/=s\d+-c/, '=s256-c');
      }
      if (src) return '<img src="' + escapeHtml(src) + '" alt="">';
      return '<span>' + escapeHtml((initial || '?').charAt(0).toUpperCase()) + '</span>';
    }

    function parentRowHtml(p, idx) {
      // Role label maps mlc/blc/parent → display string. Read-only for now —
      // the position in the array defines the role; flipping MLC/BLC between
      // two adults is unusual and would land as a separate "promote to MLC"
      // affordance later.
      var roleLabels = { mlc: 'Main Learning Coach', blc: 'Back Up Learning Coach', parent: 'Parent' };
      var roleLabel = roleLabels[p.role] || 'Parent';
      var emailIsPrimary = (p.role === 'mlc');
      var h = '<div class="emi-row" data-parent-idx="' + idx + '">';
      h += '<div class="emi-photo-thumb">' + thumbHtml(p, p.name, { wsFallback: true }) +
           '<button type="button" class="emi-photo-btn" data-role="upload-parent" data-idx="' + idx + '" aria-label="Upload photo">' +
           '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>' +
           '</button></div>';
      h += '<div class="emi-fields">';
      // Full-width header so the inputs below line up cleanly in the
       // 2-col grid, instead of the role label sharing a row with first-name.
      h += '<div class="emi-role-badge emi-full" style="font-size:0.85em;color:var(--color-text-light);font-weight:600;margin-bottom:-4px;">' + escapeHtml(roleLabel) + '</div>';
      // Hidden input keeps role in sync via data-field so the save payload
      // carries it back to the server.
      h += '<input type="hidden" data-field="role" value="' + escapeHtml(p.role || 'parent') + '">';
      // Two separate name inputs so a parent who kept their maiden name
      // (or has any surname different from the family last name) displays
      // correctly. Last name is optional — left blank, the display falls
      // back to the family last name.
      // Name + pronouns on a single row. Pronouns is narrow (longest
      // realistic entry "they/them" is short) so it shares the line with
      // first + last instead of taking its own grid row.
      h += '<div class="emi-full" style="display:flex;gap:8px;min-width:0;">';
      h += '<input class="rd-input" style="flex:3;min-width:0;" placeholder="First name" data-field="first_name" value="' + escapeHtml(p.first_name || '') + '">';
      h += '<input class="rd-input" style="flex:3;min-width:0;" placeholder="Last name (leave blank to use family last name)" data-field="last_name" value="' + escapeHtml(p.last_name || '') + '">';
      h += '<input class="rd-input" style="flex:1.5;min-width:0;" placeholder="Pronouns" data-field="pronouns" value="' + escapeHtml(p.pronouns) + '">';
      h += '</div>';
      // Email: MLC's email is the family_email (PK) — read-only here so the
      // member can't accidentally orphan their family. BLC + Parent are
      // editable so members can fill in their own Workspace login.
      var emailAttrs = emailIsPrimary
        ? 'readonly tabindex="-1" title="This is your family\'s primary login. Contact communications@ to change it."'
        : 'placeholder="Their workspace email (optional)"';
      h += '<input class="rd-input' + (emailIsPrimary ? ' emi-readonly' : '') + '" type="email" data-field="email" value="' + escapeHtml(p.email) + '" ' + emailAttrs + '>';
      // Personal email — where reminders, billing notices, etc. actually
      // get read. Editable for everyone (the MLC's personal email differs
      // from their R&W Workspace login).
      h += '<input class="rd-input" type="email" placeholder="Personal email (gmail, etc.)" data-field="personal_email" value="' + escapeHtml(p.personal_email || '') + '">';
      h += '<input class="rd-input" type="tel" placeholder="Their phone number" data-field="phone" value="' + escapeHtml(p.phone) + '">';
      var pOptOut = p.photo_consent === false;
      h += '<label class="emi-inline-label emi-full emi-photo-optout">' +
           '<input type="checkbox" data-field="photo_consent_optout"' + (pOptOut ? ' checked' : '') + '>' +
           '<span><strong>Opt out of photo and film.</strong> Roots and Wings will not use my photo, video, or quote in any co-op material.</span>' +
           '</label>';
      h += '</div>';
      h += '<button type="button" class="sc-btn sc-btn-del emi-remove" data-role="remove-parent" data-idx="' + idx + '" aria-label="Remove adult">&times;</button>';
      h += '</div>';
      return h;
    }

    function kidRowHtml(k, idx) {
      var h = '<div class="emi-row emi-kid-row" data-kid-idx="' + idx + '">';
      h += '<div class="emi-photo-thumb">' + thumbHtml(k, k.name, { wsFallback: true }) +
           '<button type="button" class="emi-photo-btn" data-role="upload-kid" data-idx="' + idx + '" aria-label="Upload photo">' +
           '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>' +
           '</button></div>';
      // 2-col emi-fields grid matching the adult layout. Row 1 packs
      // first + last + pronouns into a flex group (pronouns is short
      // enough to share the line). Row 2 pairs Birthday + Schedule.
      h += '<div class="emi-fields">';
      h += '<div class="emi-full" style="display:flex;gap:8px;min-width:0;">';
      h += '<input class="rd-input" style="flex:3;min-width:0;" placeholder="First name" data-field="name" value="' + escapeHtml(k.name) + '">';
      h += '<input class="rd-input" style="flex:3;min-width:0;" placeholder="Last name (leave blank to use family last name)" data-field="last_name" value="' + escapeHtml(k.last_name || '') + '">';
      h += '<input class="rd-input" style="flex:1.5;min-width:0;" placeholder="Pronouns" data-field="pronouns" value="' + escapeHtml(k.pronouns) + '">';
      h += '</div>';
      h += '<label class="emi-inline-label">Birthday<input type="date" class="rd-input" data-field="birth_date" value="' + escapeHtml(k.birth_date) + '"></label>';
      // Schedule is read-only here because changing it has billing implications
      // (half-day vs. full-day dues). Members contact the Membership Director to
      // change schedules; we may enable self-service once billing is integrated.
      var schedLabel = k.schedule === 'morning' ? 'Morning only'
                    : k.schedule === 'afternoon' ? 'Afternoon only'
                    : 'All day';
      h += '<label class="emi-inline-label">Schedule' +
           '<input class="rd-input emi-readonly" value="' + escapeHtml(schedLabel) + '" readonly tabindex="-1" title="Contact the Membership Director to change schedule — affects dues.">' +
           '<input type="hidden" data-field="schedule" value="' + escapeHtml(k.schedule) + '">' +
           '</label>';
      h += '<label class="emi-inline-label emi-full">' +
             'Allergies, medical &amp; notes ' +
             '<span style="font-weight:400;font-size:0.8em;color:var(--color-text-light);">— visible to all co-op members; share what teachers + leaders should know to keep your child safe.</span>' +
             '<input class="rd-input" placeholder="e.g. peanut allergy, ADHD, type-1 diabetes, sensory accommodations…" data-field="allergies" value="' + escapeHtml(k.allergies) + '">' +
           '</label>';
      var optOut = k.photo_consent === false;
      h += '<label class="emi-inline-label emi-full emi-photo-optout">' +
           '<input type="checkbox" data-field="photo_consent_optout"' + (optOut ? ' checked' : '') + '>' +
           '<span><strong>Opt out of photo and film.</strong> Roots and Wings will not use this child\'s photo, video, or quote in any co-op material.</span>' +
           '</label>';
      h += '</div>';
      h += '<button type="button" class="sc-btn sc-btn-del emi-remove" data-role="remove-kid" data-idx="' + idx + '" aria-label="Remove kid">&times;</button>';
      h += '</div>';
      return h;
    }

    function render() {
      var html = '<button class="detail-close" aria-label="Close">&times;</button>';
      html += '<div class="elective-detail emi-modal">';
      html += '<h3 style="margin:0 0 4px;">Edit My Info</h3>';
      html += '<p class="emi-subtitle">' + escapeHtml(fam.displayName || fam.name) + ' family — everything you enter here is visible to all signed-in co-op members in the directory and class rosters. (Not shown to the public.)</p>';
      html += '<div id="emiError" class="emi-error" style="display:none;"></div>';

      html += '<label class="rd-label">Family last name</label>';
      html += '<input class="rd-input" id="emiFamilyName" placeholder="e.g. Smith or O’Connor Gading" value="' + escapeHtml(state.family_name) + '">';

      html += '<label class="rd-label">Family phone</label>';
      html += '<input class="rd-input" id="emiPhone" placeholder="555-123-4567" value="' + escapeHtml(state.phone) + '">';

      html += '<label class="rd-label">Home address</label>';
      html += '<input class="rd-input" id="emiAddress" placeholder="123 Main St, Indianapolis, IN" value="' + escapeHtml(state.address) + '">';

      html += '<div class="emi-section-head"><h4>Adults in your family</h4><button type="button" class="sc-btn" id="emiAddParent">+ Add adult</button></div>';
      html += '<div id="emiParentList" class="emi-list">';
      state.parents.forEach(function (p, idx) { html += parentRowHtml(p, idx); });
      html += '</div>';

      html += '<div class="emi-section-head"><h4>Kids</h4><button type="button" class="sc-btn" id="emiAddKid">+ Add kid</button></div>';
      html += '<div id="emiKidList" class="emi-list">';
      state.kids.forEach(function (k, idx) { html += kidRowHtml(k, idx); });
      if (state.kids.length === 0) {
        html += '<p class="emi-empty">No kids added yet. Use "Add kid" above.</p>';
      }
      html += '</div>';

      html += '<div class="rd-btn-row emi-btn-row">';
      html += '<button type="button" class="rd-save-btn" id="emiSaveBtn">Save changes</button>';
      html += '<button type="button" class="rd-cancel-btn" id="emiCancelBtn">Cancel</button>';
      html += '</div>';
      html += '</div>';

      personDetailCard.innerHTML = html;
      wire();
    }

    function readAndResize(file, cb) {
      if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
        return cb(new Error('Photo must be PNG, JPEG, or WebP.'));
      }
      var reader = new FileReader();
      reader.onload = function (e) {
        var img = new Image();
        img.onload = function () {
          var max = 512;
          var w = img.width, h = img.height;
          if (w > h) { if (w > max) { h = Math.round(h * max / w); w = max; } }
          else { if (h > max) { w = Math.round(w * max / h); h = max; } }
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          cb(null, canvas.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = function () { cb(new Error('Could not decode image.')); };
        img.src = e.target.result;
      };
      reader.onerror = function () { cb(new Error('Could not read file.')); };
      reader.readAsDataURL(file);
    }

    function syncStateFromDom() {
      var familyNameEl = document.getElementById('emiFamilyName');
      var phoneEl = document.getElementById('emiPhone');
      var addressEl = document.getElementById('emiAddress');
      if (familyNameEl) state.family_name = familyNameEl.value.trim();
      if (phoneEl) state.phone = phoneEl.value;
      if (addressEl) state.address = addressEl.value;
      var pRows = personDetailCard.querySelectorAll('#emiParentList [data-parent-idx]');
      pRows.forEach(function (row) {
        var idx = parseInt(row.getAttribute('data-parent-idx'), 10);
        if (!state.parents[idx]) return;
        row.querySelectorAll('[data-field]').forEach(function (el) {
          var field = el.getAttribute('data-field');
          if (field === 'photo_consent_optout') {
            state.parents[idx].photo_consent = !el.checked;
          } else {
            state.parents[idx][field] = el.value;
          }
        });
      });
      var kRows = personDetailCard.querySelectorAll('#emiKidList [data-kid-idx]');
      kRows.forEach(function (row) {
        var idx = parseInt(row.getAttribute('data-kid-idx'), 10);
        if (!state.kids[idx]) return;
        row.querySelectorAll('[data-field]').forEach(function (el) {
          var field = el.getAttribute('data-field');
          if (field === 'photo_consent_optout') {
            // Checkbox inverts: checked = opted-out = consent false.
            state.kids[idx].photo_consent = !el.checked;
          } else {
            state.kids[idx][field] = el.value;
          }
        });
      });
    }

    function showError(msg) {
      var el = document.getElementById('emiError');
      if (!el) { alert(msg); return; }
      el.textContent = msg;
      el.style.display = '';
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    function clearError() {
      var el = document.getElementById('emiError');
      if (el) { el.style.display = 'none'; el.textContent = ''; }
    }

    // Card-level delegated click handler. Attach ONCE per modal open (stored
    // on the card element so subsequent render() calls don't stack multiple
    // listeners — the previous bug where the file picker opened N times).
    function cardClickHandler(e) {
      var upBtn = e.target.closest('[data-role="upload-parent"], [data-role="upload-kid"]');
      if (upBtn) {
        var role = upBtn.getAttribute('data-role');
        var idx = parseInt(upBtn.getAttribute('data-idx'), 10);
        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/png,image/jpeg,image/webp';
        fileInput.addEventListener('change', function () {
          var f = fileInput.files && fileInput.files[0];
          if (!f) return;
          if (f.size > 12 * 1024 * 1024) { showError('Photo is too large (max 12 MB before resize).'); return; }
          readAndResize(f, function (err, dataUrl) {
            if (err) { showError(err.message || 'Could not load image.'); return; }
            syncStateFromDom();
            if (role === 'upload-parent' && state.parents[idx]) state.parents[idx]._queuedPhoto = dataUrl;
            if (role === 'upload-kid' && state.kids[idx]) state.kids[idx]._queuedPhoto = dataUrl;
            render();
          });
        });
        fileInput.click();
        return;
      }
      var rmBtn = e.target.closest('[data-role="remove-parent"], [data-role="remove-kid"]');
      if (rmBtn) {
        var rmRole = rmBtn.getAttribute('data-role');
        var rmIdx = parseInt(rmBtn.getAttribute('data-idx'), 10);
        syncStateFromDom();
        if (rmRole === 'remove-parent') {
          if (state.parents.length <= 1) { showError('Families need at least one adult.'); return; }
          state.parents.splice(rmIdx, 1);
        } else {
          state.kids.splice(rmIdx, 1);
        }
        render();
        return;
      }
    }
    function overlayClickHandler(e) {
      if (e.target === personDetail) closeDetail();
    }

    // wire() runs after every render to (re)attach listeners to freshly-minted
    // child nodes. The card/overlay delegated listeners are attached once via
    // installModalListeners() below and NOT re-added here.
    function wire() {
      var closeBtn = personDetailCard.querySelector('.detail-close');
      if (closeBtn) closeBtn.addEventListener('click', closeDetail);
      var cancelBtn = document.getElementById('emiCancelBtn');
      if (cancelBtn) cancelBtn.addEventListener('click', closeDetail);
      var addParentBtn = document.getElementById('emiAddParent');
      if (addParentBtn) addParentBtn.addEventListener('click', function () {
        syncStateFromDom();
        // New adults default to BLC if there isn't one yet, otherwise plain
        // 'parent'. MLC is fixed (the family_email holder).
        var hasMlc = state.parents.some(function (p) { return p && p.role === 'mlc'; });
        var hasBlc = state.parents.some(function (p) { return p && p.role === 'blc'; });
        var newRole = !hasMlc ? 'mlc' : (!hasBlc ? 'blc' : 'parent');
        state.parents.push({ name: '', first_name: '', last_name: '', pronouns: '', photo_url: '', photo_consent: true, role: newRole, email: '', personal_email: '', phone: '', _queuedPhoto: null });
        render();
      });
      var addKidBtn = document.getElementById('emiAddKid');
      if (addKidBtn) addKidBtn.addEventListener('click', function () {
        syncStateFromDom();
        state.kids.push({ name: '', last_name: '', birth_date: '', pronouns: '', allergies: '', schedule: 'all-day', photo_url: '', photo_consent: true, _queuedPhoto: null });
        render();
      });
      var saveBtn = document.getElementById('emiSaveBtn');
      if (saveBtn) saveBtn.addEventListener('click', onSave);
    }

    function installModalListeners() {
      // Remove any stale handlers from a previous Edit My Info session, then
      // attach fresh ones. Stored on the elements so we can remove them on
      // close (see teardown below).
      if (personDetailCard._emiCardHandler) personDetailCard.removeEventListener('click', personDetailCard._emiCardHandler);
      if (personDetail._emiOverlayHandler) personDetail.removeEventListener('click', personDetail._emiOverlayHandler);
      personDetailCard._emiCardHandler = cardClickHandler;
      personDetail._emiOverlayHandler = overlayClickHandler;
      personDetailCard.addEventListener('click', cardClickHandler);
      personDetail.addEventListener('click', overlayClickHandler);
    }

    function teardownModalListeners() {
      if (personDetailCard._emiCardHandler) {
        personDetailCard.removeEventListener('click', personDetailCard._emiCardHandler);
        personDetailCard._emiCardHandler = null;
      }
      if (personDetail._emiOverlayHandler) {
        personDetail.removeEventListener('click', personDetail._emiOverlayHandler);
        personDetail._emiOverlayHandler = null;
      }
    }

    function closeAndCleanup() {
      teardownModalListeners();
      closeDetail();
    }

    function onSave() {
      syncStateFromDom();
      clearError();

      for (var pi = 0; pi < state.parents.length; pi++) {
        if (!String(state.parents[pi].name || '').trim()) {
          showError('Please name each adult or remove blank rows.'); return;
        }
      }
      for (var ki = 0; ki < state.kids.length; ki++) {
        if (!String(state.kids[ki].name || '').trim()) {
          showError('Please name each kid or remove blank rows.'); return;
        }
      }

      var cred = localStorage.getItem('rw_google_credential');
      if (!cred) { showError('Session expired. Please sign in again.'); return; }

      var btn = document.getElementById('emiSaveBtn');
      var originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Saving…';

      var pendingPhotos = [];
      state.parents.forEach(function (p, i) { if (p._queuedPhoto) pendingPhotos.push({ kind: 'parent', idx: i, name: p.name, data: p._queuedPhoto }); });
      state.kids.forEach(function (k, i) { if (k._queuedPhoto) pendingPhotos.push({ kind: 'kid', idx: i, name: k.name, data: k._queuedPhoto }); });

      function restoreBtn() { btn.disabled = false; btn.textContent = originalText; }

      function uploadPhoto(item) {
        return fetch('/api/tour', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cred },
          body: JSON.stringify({
            kind: 'profile-photo',
            family_email: state.family_email,
            person_name: item.name,
            data_url: item.data
          })
        }).then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
          .then(function (resp) {
            if (resp.status !== 200) throw new Error((resp.body && resp.body.error) || 'Photo upload failed.');
            if (item.kind === 'parent' && state.parents[item.idx]) {
              state.parents[item.idx].photo_url = resp.body.photo_url;
              state.parents[item.idx]._queuedPhoto = null;
            } else if (item.kind === 'kid' && state.kids[item.idx]) {
              state.kids[item.idx].photo_url = resp.body.photo_url;
              state.kids[item.idx]._queuedPhoto = null;
            }
          });
      }

      function uploadAll(i) {
        if (i >= pendingPhotos.length) return saveProfile();
        return uploadPhoto(pendingPhotos[i]).then(function () { return uploadAll(i + 1); });
      }

      function saveProfile() {
        var payload = {
          kind: 'profile-update',
          family_email: state.family_email,
          family_name: state.family_name,
          phone: state.phone,
          address: state.address,
          // Each adult sends first_name + last_name as separate fields. The
          // server composes `name` from them for legacy readers (lookupPerson,
          // allPeople matchers, etc.) so older code paths keep working.
          parents: state.parents.map(function (p) {
            var first = String(p.first_name || '').trim();
            var last = String(p.last_name || '').trim();
            var composed = [first, last].filter(Boolean).join(' ').trim();
            return { name: composed || String(p.name || '').trim(), first_name: first, last_name: last, pronouns: p.pronouns, photo_url: p.photo_url, photo_consent: p.photo_consent !== false, role: p.role || 'parent', email: p.email || '', personal_email: p.personal_email || '', phone: p.phone || '' };
          }),
          kids: state.kids.map(function (k) { return { name: k.name, last_name: k.last_name || '', birth_date: k.birth_date, pronouns: k.pronouns, allergies: k.allergies, schedule: k.schedule, photo_url: k.photo_url, photo_consent: k.photo_consent !== false }; })
        };
        return fetch('/api/tour', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cred },
          body: JSON.stringify(payload)
        }).then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
          .then(function (resp) {
            if (resp.status !== 200) throw new Error((resp.body && resp.body.error) || 'Save failed.');
            // Refresh sheets data so the overlay renders immediately.
            return fetch('/api/sheets', { headers: { 'Authorization': 'Bearer ' + cred } })
              .then(function (r) { return r.json(); })
              .then(function (data) {
                if (data && !data.error) {
                  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* quota */ }
                  applySheetsData(data);
                  if (typeof renderMyFamily === 'function') renderMyFamily();
                  if (typeof renderDirectory === 'function') renderDirectory();
                }
                closeDetail();
              })
              .catch(function () { closeDetail(); });
          });
      }

      uploadAll(0).catch(function (err) {
        showError(err.message || 'Could not save changes.');
        restoreBtn();
      });
    }

    installModalListeners();
    render();
    personDetail.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

})();

// ──────────────────────────────────────────────
// Age Group Modal
// ──────────────────────────────────────────────
var ageGroupData = {
  greenhouse: {
    emoji: '🌱',
    name: 'Greenhouse',
    range: 'Ages 0 – 2',
    desc: 'Our youngest learners stay with their parents in a nurturing, play-based space. The Greenhouse is a welcoming environment where families with babies and toddlers can connect while older siblings attend classes.',
    activities: [
      'Parent-and-child free play',
      'Sensory exploration stations',
      'Story time and music',
      'Social time for parents and caregivers'
    ]
  },
  saplings: {
    emoji: '🌿',
    name: 'Saplings',
    range: 'Ages 3 – 5',
    desc: 'Saplings discover the joy of learning through play, creativity, and gentle exploration. Classes focus on building social skills, curiosity, and a love of nature.',
    activities: [
      'Nature walks and outdoor exploration',
      'Arts and crafts',
      'Songs, movement, and creative play',
      'Early math and literacy through games',
      'Show-and-tell and storytelling'
    ]
  },
  sassafras: {
    emoji: '🍃',
    name: 'Sassafras',
    range: 'Ages 5 – 6',
    desc: 'Sassafras bridges the gap between early learners and elementary-aged kids. Hands-on projects and collaborative activities help build confidence and independence.',
    activities: [
      'Hands-on science experiments',
      'Beginning reading and writing workshops',
      'Art projects and creative expression',
      'Nature journaling',
      'Group games and teamwork activities'
    ]
  },
  oaks: {
    emoji: '🌳',
    name: 'Oaks',
    range: 'Ages 7 – 8',
    desc: 'Oaks dive deeper into subjects with curiosity-driven learning. Classes encourage critical thinking and hands-on discovery across science, history, and the arts.',
    activities: [
      'Science labs and experiments',
      'History and geography explorations',
      'Creative writing and book discussions',
      'Art and music',
      'Physical education and outdoor games'
    ]
  },
  maples: {
    emoji: '🍁',
    name: 'Maples',
    range: 'Ages 8 – 9',
    desc: 'Maples build on foundational skills with more in-depth projects and group collaboration. This is where kids really start to develop their own interests and passions.',
    activities: [
      'Project-based learning',
      'STEM challenges and building',
      'Creative arts and drama',
      'Research and presentation skills',
      'Cooperative group projects'
    ]
  },
  birch: {
    emoji: '🌲',
    name: 'Birch',
    range: 'Ages 9 – 10',
    desc: 'Birch learners take on more responsibility and dig into subjects that spark their curiosity. Classes blend academics with real-world skills and teamwork.',
    activities: [
      'In-depth science and nature study',
      'Math games and problem-solving',
      'Literature circles and writing',
      'Community service projects',
      'Leadership and life skills'
    ]
  },
  willows: {
    emoji: '🌾',
    name: 'Willows',
    range: 'Ages 10 – 11',
    desc: 'Willows are developing independence and a strong sense of self. Classes challenge them academically while fostering creativity, collaboration, and critical thinking.',
    activities: [
      'Advanced science and experiments',
      'History deep dives and debates',
      'Creative writing and journalism',
      'Art, music, and performance',
      'Mentoring younger students'
    ]
  },
  cedars: {
    emoji: '🌲',
    name: 'Cedars',
    range: 'Ages 12 – 13',
    desc: 'Cedars tackle more complex topics and develop skills for the teen years ahead. Classes emphasize critical thinking, self-directed learning, and real-world application.',
    activities: [
      'Lab sciences and research projects',
      'Essay writing and public speaking',
      'Current events and civic engagement',
      'Electives based on student interests',
      'Peer collaboration and group leadership'
    ]
  },
  pigeons: {
    emoji: '🕊️',
    name: 'Pigeons',
    range: 'Ages 14+',
    desc: 'Our oldest learners are preparing to spread their wings. Pigeons engage in advanced coursework, real-world projects, and mentorship opportunities that build confidence for whatever comes next.',
    activities: [
      'Advanced academics and electives',
      'Independent research and capstone projects',
      'Community involvement and service',
      'Mentorship and teaching younger groups',
      'Life skills, career exploration, and goal-setting'
    ]
  }
};

function openAgeGroupModal(groupId) {
  var data = ageGroupData[groupId];
  if (!data) return;
  document.getElementById('ag-modal-emoji').textContent = data.emoji;
  document.getElementById('ag-modal-title').textContent = data.name;
  document.getElementById('ag-modal-range').textContent = data.range;
  document.getElementById('ag-modal-desc').textContent = data.desc;
  var list = document.getElementById('ag-modal-activities');
  list.innerHTML = '';
  data.activities.forEach(function(item) {
    var li = document.createElement('li');
    li.textContent = item;
    list.appendChild(li);
  });
  document.getElementById('age-group-modal').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeAgeGroupModal() {
  document.getElementById('age-group-modal').classList.remove('active');
  document.body.style.overflow = '';
}

// (Absence & Coverage system is inside the IIFE above)
