# Roots & Wings Indy — Website

A static website for the Roots & Wings Indy homeschool co-op in Indianapolis, IN.

## File Structure

```
roots-and-wings/
├── index.html      — Public landing page
├── members.html    — Members-only portal (password-gated)
├── 404.html        — Custom 404 page
├── styles.css      — All styles
├── script.js       — All JavaScript
├── logo.png        — Place your logo file here
└── README.md       — This file
```

## Setup

1. Add your `logo.png` file to the root directory. The logo is referenced throughout the site and will display automatically once present.
2. Open `index.html` in a browser, or serve the directory with any static file server.

## Google Workspace Integration Points

The following placeholder URLs in `members.html` need to be replaced with real Google Workspace links:

| Resource | Placeholder | Replace With |
|---|---|---|
| Member Directory | `https://docs.google.com/spreadsheets/d/PLACEHOLDER` | Your Google Sheet URL |
| Handbook | `https://docs.google.com/document/d/PLACEHOLDER` | Your Google Doc URL |
| Reimbursement Form | `https://docs.google.com/forms/d/PLACEHOLDER-REIMBURSEMENT` | Your Google Form URL |
| Liability Waiver | `https://docs.google.com/forms/d/PLACEHOLDER-WAIVER` | Your Google Form URL |
| Google Chat | `https://chat.google.com/room/PLACEHOLDER` | Your Chat space URL |
| Shared Drive | `https://drive.google.com/drive/folders/PLACEHOLDER` | Your Drive folder URL |
| Google Calendar | (iframe in members.html) | Your Google Calendar embed `<iframe>` |

### Schedule a Tour

The "Schedule a Tour" button on the public site currently links to `#schedule-tour`. Replace this with your Google Form URL for tour requests.

## Authentication

The members portal currently uses a simple client-side password check (`rootsandwings2026`). **This is not secure** and exists only for development/demo purposes.

For production, replace with proper authentication — recommended approach:
- **Firebase Authentication** with Google sign-in, restricting to your Google Workspace domain
- This allows members to log in with their Google accounts and avoids managing passwords

## Hosting

This is a fully static site. Recommended hosting options:
- **GitHub Pages** (free)
- **Netlify** (free tier available)
- **Google Sites** (if staying within Google ecosystem, though less customizable)
- **Cloudflare Pages** (free tier available)

## Fonts

The site uses Google Fonts (Playfair Display and Nunito), loaded from the Google Fonts CDN. No local font files needed.
