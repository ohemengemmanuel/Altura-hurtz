# Altura Hertz Productions website

Website for Altura Hertz Productions, a recording studio offering recording, mixing and mastering, custom beats and cover art.

## Folders

| Folder | Contents |
|---|---|
| `development/` | The website. Plain HTML, CSS and JavaScript, no build step. This is the folder to deploy. |
| `design/` | Colour template, original studio photos and design references. |
| `documentation/` | `Deployment and Change Log.docx` (how the site works, deployment steps, change history) and the original brief. |

## Run it locally

```
cd development
python -m http.server 8000
```

Then open http://localhost:8000.

## Before launch

Contact details, social links, discount rates and the booking form endpoint are placeholders in `development/js/config.js`. See the checklist in `documentation/Deployment and Change Log.docx`.
