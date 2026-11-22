import { createBrowserChainClient } from '@atprice/chain/browser';
import { createRoot } from 'react-dom/client';
import { computeFileHash } from '../shell/document';
import { ServerSession } from '../core/server-session';
import { App, readPrefill } from '../ui/app';
import { RecoverWallet } from '../wallet/session';

const config = __RECOVER_CONFIG__;

const session = new ServerSession(config.network, (network, endpoint, onEvent) =>
  createBrowserChainClient(network, { endpoints: [endpoint], onEvent, application: 'atprice-recover' }),
);
const wallet = new RecoverWallet(config);
wallet.start();

const root = document.getElementById('root');
if (root === null) throw new Error('RECOVER_ROOT_MISSING: the file has no #root element');

createRoot(root).render(
  <App
    config={config}
    session={session}
    wallet={wallet}
    fileHash={computeFileHash(document)}
    prefill={readPrefill(window.location.search)}
  />,
);
