# WikiVault Frontend

## Installation & Execution

1. Open the `gadget.js` file and make the following changes:
   - Set the value of the `MAIN_URI` key to your server address.
   - Set the value of the `IS_DEMO` key to `false`.

2. Log in to Korean Wikipedia (https://ko.wikipedia.org).

3. Upload the `gadget.js` file to your user script page.  
   Example: `Special:MyPage/gadget.js`

4. To load the user script, add the following line to your `Special:MyPage/common.js` file:  
   ```js
   importScript('User:' + mw.config.get(mw.config.get('wgUserName')) + '/gadget.js');
   ```

## License

MIT
