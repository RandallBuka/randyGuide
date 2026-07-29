# Deploy Randy's Guide for friends (free)

Live URL after setup: **https://randallbuka.github.io/randyGuide/**

Same idea as Pourfolio: host on GitHub Pages, then friends open the link anywhere and can **Add to Home Screen** on iPhone.

## One-time GitHub setup (~5 minutes)

### 1. Create the GitHub repo and upload this project

Create an empty public repo named **`randyGuide`** under **RandallBuka**:  
https://github.com/new (name: `randyGuide`, public, no README)

**Easiest (GitHub Desktop):**

1. Install [GitHub Desktop](https://desktop.github.com/) and sign in as **RandallBuka**
2. File → Add local repository → choose `C:\Users\Randa\randyGuide`
3. If needed, create the repository / publish to **RandallBuka/randyGuide**
4. Publish branch **main**

**Or with git:**

```powershell
cd C:\Users\Randa\randyGuide
git branch -M main
git add .
git commit -m "Initial Randy's Guide with GitHub Pages deploy"
git remote add origin https://github.com/RandallBuka/randyGuide.git
git push -u origin main
```

### 2. Turn on GitHub Pages

1. Open https://github.com/RandallBuka/randyGuide/settings/pages
2. Under **Build and deployment → Source**, choose **GitHub Actions**
3. Open **Actions** — “Deploy to GitHub Pages” should run and finish green

Your site will be live at:

```
https://randallbuka.github.io/randyGuide/
```

## What to send friends

```
https://randallbuka.github.io/randyGuide/
```

**iPhone:** open in **Safari** → Share → **Add to Home Screen**  
**Android:** open in **Chrome** → **Install app** / Add to Home Screen

After that it opens like an app from the home screen.

## Keeping places up to date

GitHub Actions:

- Redeploys on every push to **main**
- Also re-syncs from your Google My Map **every 6 hours**
- You can click **Actions → Deploy to GitHub Pages → Run workflow** anytime

No need for your PC to stay on for friends to use the map.

## Local development

```powershell
cd C:\Users\Randa\randyGuide
python server.py
```

Opens at http://127.0.0.1:8080 (with live Sync now). Production on GitHub Pages uses the scheduled sync instead.
