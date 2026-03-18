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

  // The demo password — NOT SECURE, replace with real auth
  var DEMO_PASSWORD = 'rootsandwings2026';
  var SESSION_KEY = 'rw_member_auth';

  function showDashboard() {
    if (loginSection) loginSection.style.display = 'none';
    if (dashboard) dashboard.classList.add('visible');
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

    // Login form submission
    if (loginForm) {
      loginForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var pw = passwordInput ? passwordInput.value : '';

        if (pw === DEMO_PASSWORD) {
          sessionStorage.setItem(SESSION_KEY, 'true');
          if (loginError) loginError.classList.remove('visible');
          if (passwordInput) passwordInput.classList.remove('error');
          showDashboard();
        } else {
          if (loginError) loginError.classList.add('visible');
          if (passwordInput) {
            passwordInput.classList.add('error');
            passwordInput.focus();
            passwordInput.select();
          }
        }
      });
    }

    // Logout
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        showLogin();
        if (passwordInput) passwordInput.value = '';
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
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  // 7. Portal — Tabs, Table Sorting, Directory Search
  // ──────────────────────────────────────────────

  // Tab switching
  document.querySelectorAll('.portal-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var tabId = this.getAttribute('data-tab');
      // Deactivate all tabs and panels
      this.closest('.portal-tabs').querySelectorAll('.portal-tab').forEach(function (t) {
        t.classList.remove('active');
      });
      this.closest('.portal-tabs').querySelectorAll('.portal-tab-panel').forEach(function (p) {
        p.classList.remove('active');
      });
      // Activate clicked tab and matching panel
      this.classList.add('active');
      var panel = document.getElementById('tab-' + tabId);
      if (panel) panel.classList.add('active');
    });
  });

  // Table sorting
  document.querySelectorAll('.portal-table th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var table = this.closest('table');
      var tbody = table.querySelector('tbody');
      var rows = Array.from(tbody.querySelectorAll('tr'));
      var colIndex = Array.from(this.parentNode.children).indexOf(this);
      var isAsc = this.classList.contains('sort-asc');

      // Remove sort classes from all headers
      table.querySelectorAll('th').forEach(function (h) {
        h.classList.remove('sort-asc', 'sort-desc');
      });

      // Sort rows
      rows.sort(function (a, b) {
        var aText = (a.children[colIndex] || {}).textContent || '';
        var bText = (b.children[colIndex] || {}).textContent || '';
        return isAsc ? bText.localeCompare(aText) : aText.localeCompare(bText);
      });

      this.classList.add(isAsc ? 'sort-desc' : 'sort-asc');

      // Re-append sorted rows
      rows.forEach(function (row) {
        tbody.appendChild(row);
      });
    });
  });

  // Directory search (card-based)
  var directorySearch = document.getElementById('directorySearch');
  var directoryGrid = document.getElementById('directoryGrid');
  if (directorySearch && directoryGrid) {
    directorySearch.addEventListener('input', function () {
      var query = this.value.toLowerCase();
      var cards = directoryGrid.querySelectorAll('.family-card');
      cards.forEach(function (card) {
        var searchData = (card.getAttribute('data-search') || '') + ' ' + card.textContent.toLowerCase();
        card.style.display = searchData.indexOf(query) !== -1 ? '' : 'none';
      });
    });
  }

  // Directory view toggle (grid / list)
  document.querySelectorAll('.view-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var view = this.getAttribute('data-view');
      var grid = document.getElementById('directoryGrid');
      if (!grid) return;
      document.querySelectorAll('.view-btn').forEach(function (b) { b.classList.remove('active'); });
      this.classList.add('active');
      if (view === 'list') {
        grid.classList.add('list-view');
      } else {
        grid.classList.remove('list-view');
      }
    });
  });

  // ──────────────────────────────────────────────
  // 7b. Directory — "Update My Info" via Google Form
  // ──────────────────────────────────────────────
  //
  // SETUP INSTRUCTIONS:
  //
  // 1. Create a Google Form with fields in this order:
  //    Family Name, Parent(s), Email, Phone, Family Photo URL,
  //    Child 1 Name, Child 1 Age, Child 1 Group, Child 1 Photo URL,
  //    Child 2 Name, Child 2 Age, Child 2 Group, Child 2 Photo URL,
  //    Child 3 Name, Child 3 Age, Child 3 Group, Child 3 Photo URL,
  //    Child 4 Name, Child 4 Age, Child 4 Group, Child 4 Photo URL
  //
  // 2. In the form editor, click ⋮ → "Get pre-filled link"
  //    Fill in dummy values for each field, click "Get link"
  //    The URL will contain entry.XXXXXXX=DummyValue for each field
  //    Extract each entry ID and put it in the config below
  //
  // 3. Set the form responses to go to your Directory Google Sheet
  //
  // 4. In the Sheet, go to Extensions → Apps Script and paste this:
  //
  //    function onFormSubmit(e) {
  //      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Directory');
  //      var responses = e.values;
  //      var familyName = responses[1]; // adjust index based on your column order
  //      var data = sheet.getDataRange().getValues();
  //
  //      for (var i = 1; i < data.length; i++) {
  //        if (data[i][0] === familyName) {
  //          // Update existing row
  //          for (var j = 0; j < responses.length - 1; j++) {
  //            if (responses[j + 1] !== '') {
  //              sheet.getRange(i + 1, j + 1).setValue(responses[j + 1]);
  //            }
  //          }
  //          return;
  //        }
  //      }
  //      // If no match found, append as new row
  //      sheet.appendRow(responses.slice(1));
  //    }
  //
  //    Then set a trigger: Edit → Current project's triggers → Add trigger
  //    → onFormSubmit → From spreadsheet → On form submit
  //

  // Google Form configuration — fill in after creating your form
  var DIRECTORY_FORM_ID = ''; // e.g., '1FAIpQLSe...'
  var DIRECTORY_FORM_FIELDS = {
    family:     '', // e.g., 'entry.123456789'
    parents:    '', // e.g., 'entry.234567890'
    email:      '',
    phone:      '',
    familyPhoto:'',
    child1:     '', child1age: '', child1group: '', child1photo: '',
    child2:     '', child2age: '', child2group: '', child2photo: '',
    child3:     '', child3age: '', child3group: '', child3photo: '',
    child4:     '', child4age: '', child4group: '', child4photo: ''
  };

  function buildEditUrl(card) {
    if (!DIRECTORY_FORM_ID) {
      alert('Directory update form is not yet configured.\n\nTo set this up, a board member needs to:\n1. Create a Google Form for directory updates\n2. Configure the form ID in the website settings\n\nFor now, contact a board member to update your info.');
      return null;
    }

    var baseUrl = 'https://docs.google.com/forms/d/e/' + DIRECTORY_FORM_ID + '/viewform?usp=pp_url';
    var fields = DIRECTORY_FORM_FIELDS;
    var params = [];

    function add(fieldKey, value) {
      if (fields[fieldKey] && value) {
        params.push(fields[fieldKey] + '=' + encodeURIComponent(value));
      }
    }

    add('family', card.getAttribute('data-family'));
    add('parents', card.getAttribute('data-parents'));
    add('email', card.getAttribute('data-email'));
    add('phone', card.getAttribute('data-phone'));

    for (var i = 1; i <= 4; i++) {
      add('child' + i, card.getAttribute('data-child' + i));
      add('child' + i + 'age', card.getAttribute('data-age' + i));
      add('child' + i + 'group', card.getAttribute('data-group' + i));
    }

    return baseUrl + (params.length ? '&' + params.join('&') : '');
  }

  // Attach click handlers to all edit buttons
  document.querySelectorAll('[data-edit]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var card = this.closest('.family-card');
      if (!card) return;
      var url = buildEditUrl(card);
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    });
  });

  // ──────────────────────────────────────────────
  // 8. Google Sign-In (Members Portal)
  // ──────────────────────────────────────────────
  //
  // Set this to your Google Cloud OAuth Client ID to enable Google Sign-In.
  // Leave as empty string to use password-only auth.
  //
  var GOOGLE_CLIENT_ID = ''; // e.g., '123456789.apps.googleusercontent.com'
  //
  // Optional: restrict to your Google Workspace domain
  var ALLOWED_DOMAIN = ''; // e.g., 'rootsandwingsindy.com'

  if (GOOGLE_CLIENT_ID && typeof google !== 'undefined' && google.accounts) {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleSignIn,
      auto_select: false // Always show account picker
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

      // Show the divider
      var divider = document.getElementById('loginDivider');
      if (divider) divider.style.display = '';
    }
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

      // Success — store session and show dashboard
      sessionStorage.setItem(SESSION_KEY, 'true');
      sessionStorage.setItem('rw_user_name', payload.name || '');
      sessionStorage.setItem('rw_user_email', email);
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
      swatches: ['#5B8A8D', '#3D6B6E', '#D4915E', '#7A9E7E']
    },
    {
      id: 'playfair',
      label: 'Style 2',
      font: 'Playfair Display',
      logo: 'logo-new.png',
      watermark: 'logo-new.png',
      swatches: ['#2D6A3F', '#1E4F2E', '#D4712A', '#8DB43E']
    },
    {
      id: 'style3',
      label: 'Style 3',
      font: 'Cormorant Garamond',
      logo: 'logo-style3.png',
      watermark: 'logo-style3.png',
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
