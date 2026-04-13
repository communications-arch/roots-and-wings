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

  // ── Live Data Loading from Google Sheets ──
  var liveDataLoaded = false;
  var liveDataReady = false; // true once data has been applied

  var CACHE_KEY = 'rw_sheets_cache';
  var CACHE_PHOTOS_KEY = 'rw_photos_cache';
  var COMMS_EMAIL = 'communications@rootsandwingsindy.com';
  var VIEW_AS_KEY = 'rw_view_as_email';

  function getActiveEmail() {
    var viewAs = sessionStorage.getItem(VIEW_AS_KEY);
    if (viewAs) return viewAs;
    return sessionStorage.getItem('rw_user_email');
  }

  function isCommsUser() {
    return sessionStorage.getItem('rw_user_email') === COMMS_EMAIL;
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
    // Direct match
    if (DUTY_TO_ROLE_KEY[dutyText]) return DUTY_TO_ROLE_KEY[dutyText];
    // Strip trailing parenthetical like "(Finance Committee)"
    var base = dutyText.replace(/\s*\(.*\)\s*$/, '').trim();
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

    var googleCred = sessionStorage.getItem('rw_google_credential');
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
    html += '<label class="rd-label">Reviewed by</label>';
    html += '<input class="rd-input" id="rdEditReviewedBy" value="' + escapeHtml(role.last_reviewed_by || '') + '">';
    html += '<label class="rd-label">Review date</label>';
    html += '<input class="rd-input" id="rdEditReviewedDate" value="' + escapeHtml(role.last_reviewed_date || '') + '">';
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
          var newReviewedBy = personDetailCard.querySelector('#rdEditReviewedBy').value;
          var newReviewedDate = personDetailCard.querySelector('#rdEditReviewedDate').value;
          var googleCred = sessionStorage.getItem('rw_google_credential');
          fetch('/api/cleaning?action=roles&id=' + role.id, {
            method: 'PATCH',
            headers: { 'Authorization': 'Bearer ' + googleCred, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              overview: newOverview,
              job_length: newJobLength,
              duties: newDuties,
              last_reviewed_by: newReviewedBy,
              last_reviewed_date: newReviewedDate
            })
          })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.ok) {
              // Update local cache
              role.overview = newOverview;
              role.job_length = newJobLength;
              role.duties = newDuties;
              role.last_reviewed_by = newReviewedBy;
              role.last_reviewed_date = newReviewedDate;
              try { localStorage.setItem(CACHE_ROLES_KEY, JSON.stringify({ roles: roleDescriptions })); } catch (e) { /* quota */ }
              closeDetail();
              showRoleDescriptionModal(roleKey, canEdit);
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

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

    var googleCred = sessionStorage.getItem('rw_google_credential');
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
          localStorage.removeItem(CACHE_CLEANING_KEY);
          sessionStorage.removeItem(VIEW_AS_KEY);
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
    4: { floaters: ['Brittany Coleman', 'Tanya Barnes'], boardDutiesPM1: ['Molly Bellner', 'LeAnn Newlin', 'Tiffany Smith'], boardDutiesPM2: ['Erin Bogan'], supplyCloset: ['Monica Crawford'] },
    5: { floaters: [], boardDutiesPM1: ['Molly Bellner', 'LeAnn Newlin', 'Tiffany Smith'], boardDutiesPM2: ['Erin Bogan'], supplyCloset: ['Monica Crawford'] }
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
    var email = getActiveEmail();
    var section = document.getElementById('myFamily');
    var grid = document.getElementById('myFamilyGrid');
    var greeting = document.getElementById('dashboardGreeting');
    if (!email || !section || !grid) return;

    // Find the family by email
    var fam = null;
    for (var i = 0; i < FAMILIES.length; i++) {
      if (FAMILIES[i].email === email) { fam = FAMILIES[i]; break; }
    }

    var html = '';

    // ──── View As switcher (communications@ only) ────
    var viewAsEmail = sessionStorage.getItem(VIEW_AS_KEY);
    if (isCommsUser()) {
      html += '<div class="view-as-bar">';
      if (viewAsEmail && fam) {
        html += '<div class="view-as-banner">';
        html += '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        html += ' Viewing as <strong>' + fam.parents + ' ' + fam.name + '</strong>';
        html += '<button class="view-as-reset" id="viewAsReset">Back to my view</button>';
        html += '</div>';
      }
      html += '<div class="view-as-picker">';
      html += '<label>View as:</label>';
      html += '<select class="view-as-select" id="viewAsSelect">';
      html += '<option value="">— My Dashboard —</option>';
      var sortedFams = FAMILIES.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
      sortedFams.forEach(function (f) {
        var selected = viewAsEmail === f.email ? ' selected' : '';
        html += '<option value="' + f.email + '"' + selected + '>' + f.name + ' (' + f.parents + ')</option>';
      });
      html += '</select>';
      html += '</div>';
      html += '</div>';
    }

    // If no matching family (e.g. communications@ with no View As), show picker only
    if (!fam) {
      grid.innerHTML = html;
      section.style.display = '';
      // Wire View As events
      var viewAsSelect = document.getElementById('viewAsSelect');
      if (viewAsSelect) {
        viewAsSelect.onchange = function () {
          if (this.value) { sessionStorage.setItem(VIEW_AS_KEY, this.value); }
          else { sessionStorage.removeItem(VIEW_AS_KEY); }
          renderMyFamily();
          if (typeof renderCoordinationTabs === 'function') renderCoordinationTabs();
        };
      }
      if (greeting) greeting.textContent = 'Welcome!';
      return;
    }

    // Personalize greeting
    var firstName = fam.parents.split(' & ')[0].split(' ')[0];
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

    // ── Annual roles (board, committees, events) ──
    if (fam.boardRole) {
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

    // ── Render by section ──
    var blockOrder = ['AM', 'PM1', 'PM2'];
    if (hasCleaning) blockOrder.push('Cleaning');
    blockOrder.push('annual');

    var blockLabels = { AM: 'AM (10:00\u201312:00)', PM1: 'PM Hour 1 (1:00\u20131:55)', PM2: 'PM Hour 2 (2:00\u20132:55)', Cleaning: 'Cleaning', annual: 'Annual Roles' };

    // Helper to render a single duty row
    function renderDutyRow(d, globalIdx) {
      var classKey = getClassKey(d);
      var isTeacher = d.icon === 'teach';
      var h = '<div class="mf-duty' + (d.popup ? ' mf-duty-clickable' : '') + '" data-duty-idx="' + globalIdx + '"' + (d.popup ? ' style="cursor:pointer;"' : '') + '>';
      h += '<div class="mf-duty-icon">' + (DUTY_ICONS[d.icon] || '') + '</div>';
      h += '<div class="mf-duty-info"><strong>' + d.text + '</strong><span>' + d.detail + '</span>';
      if (classKey && (isTeacher || d.icon === 'assist')) {
        h += '<div class="mf-duty-link-area" data-class-key="' + classKey + '" data-is-teacher="' + (isTeacher ? '1' : '0') + '"></div>';
      }
      h += '</div>';
      // Right-aligned actions area
      h += '<div class="mf-duty-actions">';
      var dutyRoleKey = getRoleKeyForDuty(d.text);
      if (dutyRoleKey && getRoleByKey(dutyRoleKey)) {
        h += '<button class="rd-info-btn" data-role-key="' + dutyRoleKey + '" title="View role description" aria-label="View role description">';
        h += '<span class="rd-info-icon">i</span>';
        h += '</button>';
      }
      if (d.manage) {
        h += '<button class="mf-manage-btn" data-manage="' + d.manage + '">';
        h += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
        h += ' Manage</button>';
      }
      if (d.popup && !d.manage) {
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

    // Wire View As switcher
    var viewAsSelect = document.getElementById('viewAsSelect');
    if (viewAsSelect) {
      viewAsSelect.onchange = function () {
        if (this.value) {
          sessionStorage.setItem(VIEW_AS_KEY, this.value);
        } else {
          sessionStorage.removeItem(VIEW_AS_KEY);
        }
        renderMyFamily();
        if (typeof renderCoordinationTabs === 'function') renderCoordinationTabs();
      };
    }
    var viewAsReset = document.getElementById('viewAsReset');
    if (viewAsReset) {
      viewAsReset.onclick = function () {
        sessionStorage.removeItem(VIEW_AS_KEY);
        renderMyFamily();
        if (typeof renderCoordinationTabs === 'function') renderCoordinationTabs();
      };
    }

    // Wire up duty detail popups
    grid.querySelectorAll('.mf-duty-clickable').forEach(function (row) {
      row.addEventListener('click', function (e) {
        // Don't trigger detail if Manage button or info button was clicked
        if (e.target.closest('.mf-manage-btn')) return;
        if (e.target.closest('.rd-info-btn')) return;
        var idx = parseInt(this.getAttribute('data-duty-idx'), 10);
        if (duties[idx]) showDutyDetail(duties[idx]);
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

    // Wire up role description info buttons
    grid.querySelectorAll('.rd-info-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var roleKey = this.getAttribute('data-role-key');
        // Board-only roles: classroom instructor & assistant can only be edited by board members
        var boardOnlyRoles = ['classroom_instructor', 'classroom_assistant'];
        var canEdit = boardOnlyRoles.indexOf(roleKey) !== -1 ? !!(fam && fam.boardRole) : true;
        if (isCommsUser()) canEdit = true;
        showRoleDescriptionModal(roleKey, canEdit);
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

    // Wire up "I'll Be Out" button
    var absenceBtn = grid.querySelector('#reportAbsenceBtn');
    if (absenceBtn) {
      absenceBtn.addEventListener('click', showAbsenceModal);
    }

    // Render data that may already be loaded from async fetches
    if (loadedAbsences && loadedAbsences.length > 0) {
      renderMyAbsences();
      updateCoverageNotes();
    }
    if (Object.keys(classLinks).length > 0) {
      updateClassLinkButtons();
    }

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

  // Highlight names matching the current user in coordination tabs
  function getMyNames() {
    var email = getActiveEmail();
    if (!email || !FAMILIES) return { fullNames: [], familyName: '' };
    var fam = null;
    for (var i = 0; i < FAMILIES.length; i++) { if (FAMILIES[i].email === email) { fam = FAMILIES[i]; break; } }
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
    var googleCred = sessionStorage.getItem('rw_google_credential');
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
        html += '<span class="cleaning-area">' + area + '</span>';
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

    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
    html += '<div class="elective-detail sc-modal">';
    html += '<h3>Cleaning Crew Management</h3>';

    // Session selector
    html += '<div class="cle-modal-session-row">';
    html += '<label>Session:</label>';
    for (var s = 1; s <= 5; s++) {
      html += '<button class="cle-sess-btn' + (s === viewSess ? ' cle-sess-active' : '') + '" data-sess="' + s + '">' + s + '</button>';
    }
    html += '</div>';

    // Liaison
    html += '<div class="cle-liaison-row">';
    html += '<label>Liaison:</label>';
    html += '<input class="cle-input" id="clmLiaisonInput" value="' + escapeAttr(CLEANING_CREW.liaison) + '">';
    html += '<button class="cle-btn cle-btn-save" id="clmSaveLiaison">Save</button>';
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
          html += '<span class="cle-chip">' + f + '<button class="cle-chip-x" data-assign-id="' + aId + '">&times;</button></span>';
        });
        html += '</div>';
        // Add family input
        html += '<div class="cle-add-row">';
        html += '<input class="cle-input cle-add-input" placeholder="Add family name" data-area-id="' + area.id + '" data-session="' + viewSess + '">';
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
        html += '<span class="cle-chip">' + f + '<button class="cle-chip-x" data-assign-id="' + aId + '">&times;</button></span>';
      });
      html += '</div>';
      html += '<div class="cle-add-row">';
      html += '<input class="cle-input cle-add-input" placeholder="Add family name" data-area-id="' + floaterArea.id + '" data-session="' + viewSess + '">';
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

    // Wire save liaison
    document.getElementById('clmSaveLiaison').onclick = function () {
      var val = document.getElementById('clmLiaisonInput').value.trim();
      cleaningApiCall('PATCH', 'action=config', { liaison_name: val }).then(function () {
        CLEANING_CREW.liaison = val;
        try { var cc = JSON.parse(localStorage.getItem(CACHE_CLEANING_KEY) || '{}'); cc.liaison = val; localStorage.setItem(CACHE_CLEANING_KEY, JSON.stringify(cc)); } catch (e) {}
        renderCleaningModal();
        if (typeof renderMyFamily === 'function') renderMyFamily();
      });
    };

    // Wire remove assignment
    personDetailCard.querySelectorAll('.cle-chip-x').forEach(function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-assign-id');
        if (!id || id === 'null') return;
        cleaningApiCall('DELETE', 'action=assignment&id=' + id).then(function () {
          loadCleaningData();
          setTimeout(renderCleaningModal, 300);
        });
      };
    });

    // Wire add assignment
    personDetailCard.querySelectorAll('.cle-btn-add').forEach(function (btn) {
      btn.onclick = function () {
        var input = btn.parentElement.querySelector('.cle-add-input');
        var name = input.value.trim();
        if (!name) return;
        cleaningApiCall('POST', 'action=assignment', {
          session_number: parseInt(btn.getAttribute('data-session'), 10),
          cleaning_area_id: parseInt(btn.getAttribute('data-area-id'), 10),
          family_name: name
        }).then(function (r) {
          if (r.error) { alert(r.error); return; }
          loadCleaningData();
          setTimeout(renderCleaningModal, 300);
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
        html += '<div class="committee-chair"><strong>' + committee.chair.title + ':</strong> ' + highlightIfMe(committee.chair.person, myNames) + '</div>';
      }
      html += '<ul>';
      committee.roles.forEach(function (r) {
        var personText = r.person ? highlightIfMe(r.person, myNames) : '<em>Open</em>';
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
    sortBy: 'name',        // 'name' | 'location' | 'category'
    editingId: null,
    addingNew: false,
    newItemCategory: 'permanent',
    canEdit: false,
    showLocations: false   // true when location manager panel is open
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
    // True if current user is on the board, is the Supply Coordinator, or is communications@
    var realEmail = sessionStorage.getItem('rw_user_email');
    if (realEmail === COMMS_EMAIL) return true;
    var email = getActiveEmail();
    if (!email) return false;
    var me = null;
    for (var i = 0; i < FAMILIES.length; i++) {
      if (FAMILIES[i].email === email) { me = FAMILIES[i]; break; }
    }
    if (!me) return false;
    if (me.boardRole) return true;
    var coordName = getSupplyCoordinatorName();
    if (!coordName) return false;
    var lastName = coordName.trim().split(/\s+/).pop().toLowerCase();
    return me.name && me.name.toLowerCase() === lastName;
  }

  function fetchSupplyCloset() {
    var cred = sessionStorage.getItem('rw_google_credential');
    if (!cred) return Promise.reject(new Error('Not authenticated'));
    return fetch('/api/supply-closet', {
      headers: { 'Authorization': 'Bearer ' + cred }
    }).then(function (r) { return r.json(); });
  }

  function fetchSupplyLocations() {
    var cred = sessionStorage.getItem('rw_google_credential');
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
    var rows = state.items.filter(function (item) {
      if (!state.enabledCats[item.category]) return false;
      if (!q) return true;
      return (
        (item.item_name || '').toLowerCase().indexOf(q) !== -1 ||
        (item.location || '').toLowerCase().indexOf(q) !== -1 ||
        (item.notes || '').toLowerCase().indexOf(q) !== -1
      );
    });
    var sortBy = state.sortBy;
    rows.sort(function (a, b) {
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
    html += '<p class="sc-intro">Search what\'s available in the co-op\'s closets and cabinets. If something is missing or running low, post in the Supplies chat.</p>';

    // Controls: search + sort
    html += '<div class="sc-controls">';
    html += '<input type="text" class="sc-search" id="sc-search-input" placeholder="Search items, locations, notes..." value="' + escapeAttr(state.searchQuery) + '">';
    html += '<select class="sc-sort" id="sc-sort-select">';
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
    html += '</div>';

    // Category filter chips
    html += '<div class="sc-cat-filters">';
    SUPPLY_CATEGORIES.forEach(function (cat) {
      var on = state.enabledCats[cat.key];
      var classes = 'sc-cat-chip sc-cat-' + cat.key + (on ? '' : ' sc-off');
      html += '<button class="' + classes + '" data-cat="' + cat.key + '">' + cat.short + '</button>';
    });
    html += '</div>';

    // Locations row
    html += '<div class="sc-locations-row">';
    html += '<span class="sc-locations-label">Locations:</span>';
    SUPPLY_LOCATIONS.forEach(function (loc) {
      html += '<span class="sc-loc-chip">' + escapeAttr(loc) + '</span>';
    });
    if (SUPPLY_LOCATIONS.length === 0) {
      html += '<span class="sc-loc-chip sc-loc-none">None yet</span>';
    }
    if (state.canEdit) {
      html += '<button class="sc-btn sc-manage-locs-btn" id="sc-manage-locs-btn">Manage Locations</button>';
    }
    html += '</div>';

    // Count
    var totalCount = state.items ? state.items.length : 0;
    html += '<div class="sc-count">Showing ' + rows.length + ' of ' + totalCount + ' items</div>';

    // Item list
    html += '<div class="sc-list">';
    if (state.addingNew) {
      html += renderEditRow(null);
    }
    if (rows.length === 0 && !state.addingNew) {
      var msg = state.searchQuery ? 'No items match your search.' : 'No items in the selected categories.';
      html += '<div class="sc-empty">' + msg + '</div>';
    }
    rows.forEach(function (item) {
      if (state.editingId === item.id) {
        html += renderEditRow(item);
      } else {
        html += renderReadRow(item);
      }
    });
    html += '</div>';

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

  function renderReadRow(item) {
    var canEdit = supplyClosetState.canEdit;
    var cat = supplyCategoryMeta(item.category);
    var badgeLabel = cat ? cat.short : item.category;

    var html = '<div class="sc-row">';
    html += '<div>';
    html += '<div class="sc-name">' + escapeAttr(item.item_name) + '</div>';
    if (item.location) html += '<div class="sc-loc">' + escapeAttr(item.location) + '</div>';
    if (item.notes) html += '<div class="sc-notes">' + linkify(item.notes) + '</div>';
    html += '</div>';
    html += '<span class="sc-badge sc-badge-' + item.category + '">' + escapeAttr(badgeLabel) + '</span>';
    html += '<div class="sc-actions">';
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
    var cred = sessionStorage.getItem('rw_google_credential');
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
        if (!confirm('Delete "' + locName + '"? Items using this location will have their location cleared.')) return;
        btn.disabled = true;
        fetch('/api/supply-closet?action=locations&id=' + encodeURIComponent(id), {
          method: 'DELETE',
          headers: headers
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.error) { alert('Error: ' + data.error); btn.disabled = false; return; }
          return fetchSupplyLocations().then(function () { renderLocationManager(); });
        }).catch(function (err) { alert('Network error: ' + err.message); btn.disabled = false; });
      });
    });
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

        var cred = sessionStorage.getItem('rw_google_credential');
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
        var cred = sessionStorage.getItem('rw_google_credential');
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

    var html = '';
    if (state.addingNew) html += renderEditRow(null);
    if (rows.length === 0 && !state.addingNew) {
      var msg = state.searchQuery ? 'No items match your search.' : 'No items in the selected categories.';
      html += '<div class="sc-empty">' + msg + '</div>';
    }
    rows.forEach(function (item) {
      if (state.editingId === item.id) {
        html += renderEditRow(item);
      } else {
        html += renderReadRow(item);
      }
    });
    listEl.innerHTML = html;

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

    var cred = sessionStorage.getItem('rw_google_credential');
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
    var cred = sessionStorage.getItem('rw_google_credential');
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
    var cred = sessionStorage.getItem('rw_google_credential');
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
    var email = sessionStorage.getItem('rw_user_email');
    if (!email) return false;
    for (var i = 0; i < FAMILIES.length; i++) {
      if (FAMILIES[i].email === email && FAMILIES[i].boardRole) return true;
    }
    return false;
  }

  // Returns an array of teaching/assisting assignments for the current user
  // across all sessions. Used to pre-fill the curriculum editor.
  function getMyTeachingAssignments() {
    var email = sessionStorage.getItem('rw_user_email');
    if (!email) return [];
    var fam = null;
    for (var i = 0; i < FAMILIES.length; i++) {
      if (FAMILIES[i].email === email) { fam = FAMILIES[i]; break; }
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
    var email = sessionStorage.getItem('rw_user_email');
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
    var cred = sessionStorage.getItem('rw_google_credential');
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
      var oldCred = sessionStorage.getItem('rw_google_credential');
      var done = false;
      function check() {
        var c = sessionStorage.getItem('rw_google_credential');
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
    var html = '<button class="detail-close" aria-label="Close">&times;</button>';
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
    var overviewEl = personDetailCard.querySelector('#cl-f-overview');
    var tagsEl = personDetailCard.querySelector('#cl-f-tags');
    var lcEl = personDetailCard.querySelector('#cl-f-lesson-count');
    var polEl = personDetailCard.querySelector('#cl-f-edit-policy');

    if (titleEl) d.title = titleEl.value;
    if (subjEl) d.subject = subjEl.value;
    if (ageEl) d.age_range = ageEl.value;
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
          var cred = sessionStorage.getItem('rw_google_credential');
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
      '.steps { display: grid; grid-template-columns: 24pt 1fr 1fr; gap: 8pt; }',
      '.steps .header { font-weight: 700; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em; padding-bottom: 4pt; border-bottom: 1pt solid #333; }',
      '.steps .num { text-align: right; padding-right: 4pt; font-weight: 700; }',
      '.steps .cell { padding: 4pt 0; border-bottom: 0.5pt solid #ccc; }',
      '.qty { color: #555; font-size: 9pt; }',
      '.notes { color: #555; font-size: 9pt; font-style: italic; }',
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
          html += '<li><strong>' + esc(r.name) + '</strong>' + qtyStr + lessonsStr + notesStr + '</li>';
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
    var w = window.open('', '_blank', 'width=900,height=700');
    if (!w) {
      alert('Could not open print window. Please allow popups for this site and try again.');
      return;
    }
    w.document.open();
    w.document.write(buildPrintHtml(curr));
    w.document.close();
    // Give the browser a moment to layout, then trigger print
    setTimeout(function () {
      try { w.focus(); w.print(); } catch (e) { /* user can use the Print button in the new window */ }
    }, 300);
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
          var row = { name: name, qty: qty, unit: unit, location: location, notes: notes, lessons: [ls.lesson_number], id: s.id || null, closet_item_id: s.closet_item_id };
          keyToRow[sig] = row;
          rows.push(row);
        }
      });
    });
    rows.forEach(function (r) { r.lessons.sort(function (a, b) { return a - b; }); });
    return rows;
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
    return '<span class="' + (opts && opts.nameClass || 'cl-master-name') + '">' + esc(r.name) + '</span>' + qtyStr + lessonsStr + notesStr;
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
    html += '<button class="cl-icon-btn" id="cl-print-btn" aria-label="Print" title="Print">';
    html += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>';
    html += '</button>';
    html += '</div>';
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
            var line = escapeAttr(s.item_name);
            var qtyParts = [];
            if (s.qty) qtyParts.push(escapeAttr(s.qty));
            if (s.qty_unit === 'student') qtyParts.push('per student');
            else if (s.qty_unit === 'class') qtyParts.push('per class');
            if (qtyParts.length) line += ' <span class="cl-qty">(' + qtyParts.join(' ') + ')</span>';
            if (s.notes) line += ' <span class="cl-notes">&mdash; ' + linkify(s.notes) + '</span>';
            html += '<li>' + line + '</li>';
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
      logo: 'logo-style2-full.png',
      watermark: 'logo-style2-mark.png',
      brandText: 'Roots & Wings',
      useFullLogo: true,
      swatches: ['#1F6B3F', '#E8624E', '#4FB5B8', '#F0C674']
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
        img.style.height = '80px';
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

  // ═══════════════════════════════════════════════════════
  // ABSENCE & COVERAGE SYSTEM (inside IIFE for scope access)
  // ═══════════════════════════════════════════════════════

  window._rw_getTuesdaysInSession = getTuesdaysInSession;
  window._rw_showAbsenceModal = showAbsenceModal;
  window._rw_loadCoverageBoard = loadCoverageBoard;
  window._rw_loadNotifications = loadNotifications;
  window._rw_initAbsenceCoverageSystem = initAbsenceCoverageSystem;
  window._rw_initPushSubscription = initPushSubscription;

  function getTuesdaysInSession(sessionNumber) {
    var sess = SESSION_DATES[sessionNumber];
    if (!sess) return [];
    var tuesdays = [];
    var d = new Date(sess.start + 'T12:00:00');
    var end = new Date(sess.end + 'T12:00:00');
    while (d.getDay() !== 2) d.setDate(d.getDate() + 1);
    while (d <= end) {
      tuesdays.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 7);
    }
    return tuesdays;
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

  function showAbsenceModal() {
    var email = sessionStorage.getItem('rw_user_email');
    if (!email || !FAMILIES) return;
    var me = null;
    for (var i = 0; i < FAMILIES.length; i++) { if (FAMILIES[i].email === email) { me = FAMILIES[i]; break; } }
    if (!me) { alert('Could not find your family record.'); return; }
    var tuesdays = getTuesdaysInSession(currentSession);
    if (tuesdays.length === 0) { alert('No session dates available.'); return; }

    var parentNames = me.parents.split(' & ').map(function (p) { return p.trim() + ' ' + me.name; });

    // Determine which blocks this person actually has duties in
    var allBlocks = ['AM', 'PM1', 'PM2', 'Cleaning'];
    var allSlots = getResponsibilitiesForBlocks(parentNames, currentSession, allBlocks, me.name);
    var activeBlocks = {};
    allSlots.forEach(function (s) { activeBlocks[s.block] = true; });

    var blockLabelsModal = { AM: 'AM (10:00\u201312:00)', PM1: 'PM1 (1:00\u20131:55)', PM2: 'PM2 (2:00\u20132:55)', Cleaning: 'Cleaning' };

    var html = '<div class="absence-overlay" id="absenceOverlay"><div class="absence-modal">';
    html += '<button class="detail-close absence-close" id="absenceCloseBtn">&times;</button>';
    html += '<h3>Report an Absence</h3>';
    html += '<div class="absence-field"><label>Who will be out?</label><select class="cl-input" id="absenceWho">';
    parentNames.forEach(function (name) { html += '<option value="' + name + '">' + name + '</option>'; });
    html += '</select></div>';
    html += '<div class="absence-field"><label>Which day?</label><div class="absence-dates" id="absenceDates">';
    tuesdays.forEach(function (d, idx) { html += '<button class="absence-date-btn' + (idx === 0 ? ' active' : '') + '" data-date="' + d + '">' + formatDateLabel(d) + '</button>'; });
    html += '</div></div>';
    html += '<div class="absence-field"><label>What will you miss?</label><div class="absence-blocks">';
    html += '<label class="absence-block-label"><input type="checkbox" id="absenceWholeDay" checked> <strong>Whole Day</strong></label>';
    allBlocks.forEach(function (blk) {
      if (activeBlocks[blk]) {
        html += '<label class="absence-block-label"><input type="checkbox" class="absence-block-cb" value="' + blk + '" checked> ' + blockLabelsModal[blk] + '</label>';
      }
    });
    html += '</div></div>';
    html += '<div class="absence-field"><label>Responsibilities needing coverage:</label><div class="absence-preview" id="absencePreview"></div></div>';
    html += '<div class="absence-field"><label>Notes (optional)</label><input class="cl-input" id="absenceNotes" placeholder="e.g. sick kids, appointment..."></div>';
    html += '<button class="btn btn-primary absence-submit" id="absenceSubmitBtn">Submit \u2014 I\'m Out</button>';
    html += '</div></div>';
    document.body.insertAdjacentHTML('beforeend', html);

    var overlay = document.getElementById('absenceOverlay');
    var selectedDate = tuesdays[0];
    var selectedPerson = parentNames[0];

    function getSelectedBlocks() {
      var blocks = [];
      overlay.querySelectorAll('.absence-block-cb').forEach(function (cb) { if (cb.checked) blocks.push(cb.value); });
      return blocks;
    }
    function updatePreview() {
      var slotsPreview = getResponsibilitiesForBlocks([selectedPerson], currentSession, getSelectedBlocks(), me.name);
      var previewEl = document.getElementById('absencePreview');
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
    wholeDayCb.addEventListener('change', function () {
      overlay.querySelectorAll('.absence-block-cb').forEach(function (cb) { cb.checked = wholeDayCb.checked; });
      updatePreview();
    });
    overlay.querySelectorAll('.absence-block-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var allChecked = true;
        overlay.querySelectorAll('.absence-block-cb').forEach(function (c) { if (!c.checked) allChecked = false; });
        wholeDayCb.checked = allChecked;
        updatePreview();
      });
    });
    document.getElementById('absenceSubmitBtn').addEventListener('click', function () {
      var blocks = getSelectedBlocks();
      if (blocks.length === 0) { alert('Please select at least one block.'); return; }
      var slotsToSend = getResponsibilitiesForBlocks([selectedPerson], currentSession, blocks, me.name);
      var btn = document.getElementById('absenceSubmitBtn');
      btn.disabled = true; btn.textContent = 'Submitting\u2026';
      var cred = sessionStorage.getItem('rw_google_credential');
      fetch('/api/absences', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' },
        body: JSON.stringify({ absent_person: selectedPerson, family_email: me.email, family_name: me.name, session_number: currentSession, absence_date: selectedDate, blocks: blocks, slots: slotsToSend, notes: (document.getElementById('absenceNotes') || {}).value || '' })
      }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) { alert('Error: ' + (res.data.error || 'Could not submit absence')); btn.disabled = false; btn.textContent = 'Submit \u2014 I\'m Out'; return; }
        overlay.remove();
        loadCoverageBoard();
        loadNotifications();
      });
    });
    updatePreview();
  }

  function loadCoverageBoard() {
    var cred = sessionStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/absences?session=' + currentSession, { headers: { 'Authorization': 'Bearer ' + cred } })
    .then(function (r) { return r.json(); })
    .then(function (data) { renderCoverageBoard((data.absences || []).filter(function (a) { return !a.cancelled_at; })); })
    .catch(function () { var el = document.getElementById('coverageBoardContent'); if (el) el.innerHTML = '<p>Could not load coverage data.</p>'; });
  }

  // Store loaded absences so responsibilities card can reference them
  var loadedAbsences = [];

  function renderCoverageBoard(absences) {
    loadedAbsences = absences;
    var el = document.getElementById('coverageBoardContent');
    var card = document.getElementById('coverageBoardCard');
    if (!el) return;
    if (absences.length === 0) {
      if (card) card.style.display = 'none';
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

    var email = sessionStorage.getItem('rw_user_email');
    var me = null;
    for (var i = 0; i < FAMILIES.length; i++) { if (FAMILIES[i].email === email) { me = FAMILIES[i]; break; } }
    var myName = me ? me.parents.split(' & ')[0].trim() + ' ' + me.name : '';

    // Group absences by date
    var byDate = {};
    absences.forEach(function (a) {
      var dateKey = String(a.absence_date || '').slice(0, 10);
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push(a);
    });

    var tuesdays = getTuesdaysInSession(currentSession);
    var activeDates = tuesdays.filter(function (d) { return byDate[d] && byDate[d].length > 0; });
    if (activeDates.length === 0) { if (card) card.style.display = 'none'; return; }

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

    // Build panels — primary view: open slots only, detail view: all coverage
    activeDates.forEach(function (date) {
      var dateAbsences = byDate[date] || [];
      var isActive = date === defaultDate;

      // Collect open and covered slots
      var openSlots = [];
      var allSlotsByPerson = [];
      dateAbsences.forEach(function (a) {
        var personSlots = { person: a.absent_person, notes: a.notes, slots: [] };
        (a.slots || []).forEach(function (slot) {
          slot._person = a.absent_person;
          if (!slot.claimed_by_email) openSlots.push(slot);
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
          html += '<div class="coverage-slot coverage-slot-open">';
          html += '<span class="coverage-slot-block">' + slot.block + '</span>';
          html += '<span class="coverage-slot-desc">' + slot.role_description + ' <span class="coverage-slot-for">(' + slot._person + ')</span></span>';
          html += '<button class="btn btn-sm btn-cover" data-slot-id="' + slot.id + '">I\'ll Cover This</button>';
          html += '</div>';
        });
        html += '</div>';
      } else {
        html += '<div class="coverage-all-covered">All slots covered for this day!</div>';
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
        var cred = sessionStorage.getItem('rw_google_credential');
        fetch('/api/coverage', { method: 'POST', headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' }, body: JSON.stringify({ slot_id: slotId, claimer_name: myName }) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) { if (!res.ok) { alert('Error: ' + (res.data.error || 'claim failed')); btn.disabled = false; btn.textContent = 'I\'ll Cover This'; return; } loadCoverageBoard(); loadNotifications(); });
      });
    });

    // Update responsibility coverage notes and my absences
    updateCoverageNotes();
    renderMyAbsences();
  }

  // Add coverage notes to the responsibilities card
  // If someone in your class/elective is out, show who's covering
  function updateCoverageNotes() {
    if (!loadedAbsences || loadedAbsences.length === 0) return;
    var notesContainer = document.getElementById('coverageNotesArea');
    if (!notesContainer) return;

    var email = sessionStorage.getItem('rw_user_email');
    var me = null;
    for (var i = 0; i < FAMILIES.length; i++) { if (FAMILIES[i].email === email) { me = FAMILIES[i]; break; } }
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

    // Check if any absent person has a slot matching my classes/electives
    var notes = [];
    loadedAbsences.forEach(function (a) {
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

    var email = sessionStorage.getItem('rw_user_email');
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
      html += '</div>';
    });
    html += '</div>';
    el.innerHTML = html;

    // Wire cancel buttons
    el.querySelectorAll('.my-absence-cancel').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-absence-id');
        if (!confirm('Cancel this absence? Coverage slots will be removed.')) return;
        btn.disabled = true; btn.textContent = 'Cancelling\u2026';
        var cred = sessionStorage.getItem('rw_google_credential');
        fetch('/api/absences?id=' + encodeURIComponent(id), {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + cred }
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (res.error) { alert('Error: ' + res.error); btn.disabled = false; btn.textContent = 'Cancel'; return; }
          loadCoverageBoard();
        });
      });
    });

    // Wire edit buttons — cancel the old one and re-open the modal
    el.querySelectorAll('.my-absence-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-absence-id');
        var absence = null;
        for (var i = 0; i < loadedAbsences.length; i++) {
          if (String(loadedAbsences[i].id) === id) { absence = loadedAbsences[i]; break; }
        }
        if (!absence) return;
        // Cancel the old absence, then open the modal pre-filled
        btn.disabled = true; btn.textContent = 'Loading\u2026';
        var cred = sessionStorage.getItem('rw_google_credential');
        fetch('/api/absences?id=' + encodeURIComponent(id), {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + cred }
        }).then(function (r) { return r.json(); }).then(function () {
          loadCoverageBoard();
          showAbsenceModal();
        });
      });
    });
  }

  var notifState = { notifications: [], unreadCount: 0, dropdownOpen: false };

  function loadNotifications() {
    var cred = sessionStorage.getItem('rw_google_credential');
    if (!cred) return;
    fetch('/api/notifications?limit=20', { headers: { 'Authorization': 'Bearer ' + cred } })
    .then(function (r) { return r.json(); })
    .then(function (data) { notifState.notifications = data.notifications || []; notifState.unreadCount = data.unread_count || 0; updateNotifBadge(); if (notifState.dropdownOpen) renderNotifDropdown(); })
    .catch(function () {});
  }

  function updateNotifBadge() {
    document.querySelectorAll('.notif-badge').forEach(function (badge) {
      if (notifState.unreadCount > 0) { badge.textContent = notifState.unreadCount > 99 ? '99+' : notifState.unreadCount; badge.style.display = ''; }
      else { badge.style.display = 'none'; }
    });
  }

  function renderNotifDropdown() {
    var existing = document.getElementById('notifDropdown');
    if (existing) existing.remove();
    var bell = document.getElementById('notifBellBtn');
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
    if (markAllBtn) { markAllBtn.addEventListener('click', function (e) { e.stopPropagation(); var cred = sessionStorage.getItem('rw_google_credential'); fetch('/api/notifications?mark_all_read=true', { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' } }).then(function () { loadNotifications(); }); }); }
    dropdown.querySelectorAll('.notif-item').forEach(function (item) { item.addEventListener('click', function () { var id = item.getAttribute('data-notif-id'); var cred = sessionStorage.getItem('rw_google_credential'); fetch('/api/notifications?id=' + id, { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' } }).then(function () { loadNotifications(); }); var cov = document.getElementById('coverage'); if (cov) cov.scrollIntoView({ behavior: 'smooth' }); closeNotifDropdown(); }); });
    setTimeout(function () { document.addEventListener('click', closeNotifOnOutsideClick); }, 10);
  }

  function closeNotifOnOutsideClick(e) { var dropdown = document.getElementById('notifDropdown'); var bell = document.getElementById('notifBellBtn'); if (dropdown && !dropdown.contains(e.target) && !bell.contains(e.target)) closeNotifDropdown(); }
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
      .then(function (sub) { var cred = sessionStorage.getItem('rw_google_credential'); var subJson = sub.toJSON(); return fetch('/api/push-subscribe', { method: 'POST', headers: { 'Authorization': 'Bearer ' + cred, 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys }) }); })
      .then(function (r) { if (!r.ok) throw new Error('Subscribe failed'); banner.innerHTML = '<div class="container push-banner-inner" style="justify-content:center;color:var(--color-primary);"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> <strong>Notifications enabled!</strong></div>'; setTimeout(function () { hideBanner(); }, 3000); })
      .catch(function (err) { console.error('Push subscription error:', err); enableBtn.disabled = false; enableBtn.textContent = 'Enable'; if (Notification.permission === 'denied') alert('Notifications are blocked. Please enable them in your browser settings.'); });
    });
  }

  function urlBase64ToUint8Array(base64String) { var padding = '='.repeat((4 - base64String.length % 4) % 4); var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/'); var rawData = atob(base64); var out = new Uint8Array(rawData.length); for (var i = 0; i < rawData.length; ++i) out[i] = rawData.charCodeAt(i); return out; }

  // ── Class-Curriculum Links ──
  var classLinks = {}; // class_key → { id, curriculum_id, curriculum_title, ... }

  function loadClassLinks() {
    var cred = sessionStorage.getItem('rw_google_credential');
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
        var cred = sessionStorage.getItem('rw_google_credential');
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
    var cred = sessionStorage.getItem('rw_google_credential');
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
      '.class-header { background: #f5f5f5; border: 1.5pt solid #333; padding: 12pt 14pt; margin-bottom: 14pt; }',
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
      '.steps { display: grid; grid-template-columns: 24pt 1fr 1fr; gap: 6pt; }',
      '.steps .header { font-weight: 700; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em; padding-bottom: 4pt; border-bottom: 1pt solid #333; }',
      '.steps .num { text-align: right; padding-right: 4pt; font-weight: 700; }',
      '.steps .cell { padding: 3pt 0; border-bottom: 0.5pt solid #ccc; font-size: 10pt; }',
      '@media print { .no-print { display: none; } }',
      '.no-print { text-align: center; padding: 10pt; background: #ffe; border-bottom: 1pt solid #ccc; margin: -0.25in -0.25in 12pt -0.25in; }',
      '.no-print button { font-size: 11pt; padding: 6pt 16pt; cursor: pointer; margin: 0 4pt; }'
    ].join('\n');

    var html = '<!doctype html><html><head><meta charset="utf-8"><title>Class Pack: ' + esc(info.name) + '</title><style>' + css + '</style></head><body>';
    html += '<div class="no-print"><button onclick="window.print()">Print</button> <button onclick="window.close()">Close</button></div>';

    // ── Class header ──
    html += '<div class="class-header">';
    html += '<h1>' + esc(info.name) + (info.ageRange ? ' <span style="font-size:12pt;color:#555;">(' + esc(info.ageRange) + ')</span>' : '') + '</h1>';
    html += '<div class="meta">' + esc(sessName) + '</div>';
    html += '<dl class="class-detail">';
    html += '<dt>Time</dt><dd>' + esc(info.time) + '</dd>';
    html += '<dt>Room</dt><dd>' + esc(info.room) + '</dd>';
    html += '<dt>Teacher</dt><dd>' + esc(info.teacher) + '</dd>';
    if (info.assistants.length) { html += '<dt>Assistants</dt><dd>' + esc(info.assistants.join(', ')) + '</dd>'; }
    if (info.topic) { html += '<dt>Topic</dt><dd>' + esc(info.topic) + '</dd>'; }
    html += '</dl>';

    // Student roster (PM electives have student lists)
    if (info.students && info.students.length > 0) {
      html += '<div class="roster"><div class="roster-title">Students (' + info.students.length + ')</div><ul class="roster-list">';
      info.students.forEach(function (s) { html += '<li>' + esc(s) + '</li>'; });
      html += '</ul></div>';
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
            html += '<li><strong>' + esc(r.name) + '</strong>' + qtyStr + lessonsStr + notesStr + '</li>';
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

    var w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { alert('Could not open window. Please allow popups.'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  function showAttachPicker(classKey) {
    // Load curriculum list if not cached
    var cred = sessionStorage.getItem('rw_google_credential');
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
    if (bellBtn) { bellBtn.addEventListener('click', function (e) { e.stopPropagation(); if (notifState.dropdownOpen) closeNotifDropdown(); else { notifState.dropdownOpen = true; renderNotifDropdown(); } }); }
    loadCoverageBoard();
    loadClassLinks();
    loadNotifications();
    setInterval(loadNotifications, 60000);
    initPushSubscription();
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
