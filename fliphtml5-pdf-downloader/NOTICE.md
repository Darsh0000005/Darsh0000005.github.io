# Credits

The code in this folder was written from scratch. How it talks to FlipHTML5 follows the open-source project
**fliphtml5-downloader** (<https://github.com/nyr-github/fliphtml5-downloader>), whose README declares the MIT licence:

- a book's configuration is read from `https://online.fliphtml5.com/<id1>/<id2>/javascript/config.js` (`htmlConfig = {...}`);
- encrypted page lists are decoded with FlipHTML5's own `deString.js`, loaded the way its reader loads it;
- page image URLs are built from the page list entries (`files/large/...`);
- books flagged `isEncryptionBook` are refused.

"FlipHTML5" belongs to its owners. This project is not affiliated with or endorsed by FlipHTML5.
