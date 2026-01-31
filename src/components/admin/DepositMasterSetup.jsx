import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { 
  Key, 
  CheckCircle, 
  XCircle, 
  Loader2, 
  AlertTriangle,
  Copy,
  Eye,
  EyeOff,
  ShieldAlert
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

export default function DepositMasterSetup() {
  const queryClient = useQueryClient();
  const [showInitDialog, setShowInitDialog] = useState(false);
  const [initChain, setInitChain] = useState(null);
  const [walletData, setWalletData] = useState(null);
  const [mnemonicVisible, setMnemonicVisible] = useState(false);
  const [copied, setCopied] = useState({ mnemonic: false, xpub: false });

  const { data: status, isLoading } = useQuery({
    queryKey: ['xpub-status'],
    queryFn: async () => {
      const res = await base44.functions.invoke('walletUtils', { action: 'get_xpub_status' });
      return res.data;
    }
  });

  const initMutation = useMutation({
    mutationFn: async (chain) => {
      const res = await base44.functions.invoke('walletUtils', { 
        action: 'init_deposit_master',
        chain 
      });
      if (res.data.error) throw new Error(res.data.error);
      return res.data;
    },
    onSuccess: (data) => {
      setWalletData(data);
    },
    onError: (err) => {
      toast.error(err.message);
      setShowInitDialog(false);
    }
  });

  const handleInitClick = (chain) => {
    setInitChain(chain);
    setWalletData(null);
    setMnemonicVisible(false);
    setCopied({ mnemonic: false, xpub: false });
    setShowInitDialog(true);
  };

  const handleConfirmInit = () => {
    initMutation.mutate(initChain);
  };

  const handleCopy = (text, type) => {
    navigator.clipboard.writeText(text);
    setCopied(prev => ({ ...prev, [type]: true }));
    toast.success(`${type === 'mnemonic' ? 'Mnemonic' : 'xpub'} copied`);
    setTimeout(() => setCopied(prev => ({ ...prev, [type]: false })), 2000);
  };

  const handleClose = () => {
    if (walletData) {
      queryClient.invalidateQueries({ queryKey: ['xpub-status'] });
    }
    setShowInitDialog(false);
    setWalletData(null);
    setMnemonicVisible(false);
  };

  if (isLoading) {
    return (
      <div className="bg-slate-950 border border-red-900/50 rounded-lg p-6">
        <div className="flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-red-500 animate-spin" />
        </div>
      </div>
    );
  }

  const depositStatus = status?.deposit_master || {};

  return (
    <>
      <div className="bg-slate-950 border border-red-900/50 rounded-lg">
        <div className="p-4 border-b border-red-900/30 flex items-center gap-3">
          <Key className="w-5 h-5 text-red-500" />
          <div>
            <h2 className="text-lg text-slate-100">Deposit Master Wallets</h2>
            <p className="text-xs text-slate-500">HD wallet xpubs for worker deposit address derivation</p>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {/* ETH Status */}
          <div className="flex items-center justify-between p-3 bg-black/30 rounded-lg border border-red-900/20">
            <div className="flex items-center gap-3">
              <span className="px-2 py-0.5 text-xs font-bold rounded bg-blue-900/50 text-blue-400">
                ETH
              </span>
              {depositStatus.ETH ? (
                <>
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span className="text-sm text-green-400">Configured</span>
                </>
              ) : (
                <>
                  <XCircle className="w-4 h-4 text-red-500" />
                  <span className="text-sm text-red-400">Not configured</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-3">
              {depositStatus.ETH_fingerprint && (
                <code className="text-xs text-slate-500 font-mono">
                  {depositStatus.ETH_fingerprint}
                </code>
              )}
              {!depositStatus.ETH && (
                <Button
                  size="sm"
                  onClick={() => handleInitClick('ETH')}
                  className="bg-red-600 hover:bg-red-700 text-white"
                >
                  Initialize
                </Button>
              )}
            </div>
          </div>

          {/* BTC Status */}
          <div className="flex items-center justify-between p-3 bg-black/30 rounded-lg border border-red-900/20">
            <div className="flex items-center gap-3">
              <span className="px-2 py-0.5 text-xs font-bold rounded bg-orange-900/50 text-orange-400">
                BTC
              </span>
              {depositStatus.BTC ? (
                <>
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span className="text-sm text-green-400">Configured</span>
                </>
              ) : (
                <>
                  <XCircle className="w-4 h-4 text-red-500" />
                  <span className="text-sm text-red-400">Not configured</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-3">
              {depositStatus.BTC_fingerprint && (
                <code className="text-xs text-slate-500 font-mono">
                  {depositStatus.BTC_fingerprint}
                </code>
              )}
              {!depositStatus.BTC && (
                <Button
                  size="sm"
                  onClick={() => handleInitClick('BTC')}
                  className="bg-red-600 hover:bg-red-700 text-white"
                >
                  Initialize
                </Button>
              )}
            </div>
          </div>

          {/* API Status */}
          <div className="flex items-center gap-2 text-xs text-slate-500 pt-2 border-t border-red-900/20">
            <span>Tatum API:</span>
            {status?.api_configured ? (
              <span className="text-green-400">Connected</span>
            ) : (
              <span className="text-red-400">Not configured</span>
            )}
            {status?.testnet && (
              <span className="ml-2 px-1.5 py-0.5 bg-yellow-900/30 text-yellow-400 rounded text-xs">
                TESTNET
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Initialize Dialog */}
      <Dialog open={showInitDialog} onOpenChange={handleClose}>
        <DialogContent className="bg-slate-950 border-red-900/50 max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-slate-100 flex items-center gap-2">
              <Key className="w-5 h-5 text-red-500" />
              Initialize Deposit Master ({initChain})
            </DialogTitle>
            <DialogDescription className="text-slate-400">
              {!walletData 
                ? 'This will generate a new HD wallet for worker deposit addresses.'
                : 'Wallet generated. Copy the mnemonic NOW - it will NOT be shown again.'
              }
            </DialogDescription>
          </DialogHeader>

          {!walletData ? (
            <div className="space-y-4">
              <div className="p-4 bg-red-900/20 border border-red-500/50 rounded-lg">
                <div className="flex items-start gap-3">
                  <ShieldAlert className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                  <div className="text-sm text-red-300">
                    <p className="font-semibold mb-2">Security Warning</p>
                    <ul className="space-y-1 text-red-400/80 text-xs">
                      <li>• The mnemonic will be shown ONCE only</li>
                      <li>• Store it in a secure OFFLINE location</li>
                      <li>• NEVER store in code, logs, or databases</li>
                      <li>• Anyone with the mnemonic controls all funds</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div className="flex gap-3 justify-end">
                <Button
                  variant="outline"
                  onClick={handleClose}
                  className="border-slate-700 text-slate-300"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleConfirmInit}
                  disabled={initMutation.isPending}
                  className="bg-red-600 hover:bg-red-700"
                >
                  {initMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    'Generate Wallet'
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Warning Banner */}
              <div className="p-3 bg-yellow-900/30 border border-yellow-500/50 rounded-lg">
                <div className="flex items-center gap-2 text-yellow-400 text-sm font-semibold">
                  <AlertTriangle className="w-4 h-4" />
                  Copy the mnemonic NOW - it will NOT be shown again!
                </div>
              </div>

              {/* Mnemonic */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-slate-400 uppercase tracking-wider">
                    Mnemonic (24 words)
                  </label>
                  <button
                    onClick={() => setMnemonicVisible(!mnemonicVisible)}
                    className="text-slate-500 hover:text-slate-300"
                  >
                    {mnemonicVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="relative">
                  <div className={`p-3 bg-black border border-red-900/50 rounded-lg font-mono text-xs break-all ${
                    mnemonicVisible ? 'text-red-400' : 'text-transparent select-none'
                  }`} style={{ textShadow: mnemonicVisible ? 'none' : '0 0 8px rgba(239, 68, 68, 0.5)' }}>
                    {walletData.mnemonic}
                  </div>
                  {!mnemonicVisible && (
                    <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
                      Click eye icon to reveal
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleCopy(walletData.mnemonic, 'mnemonic')}
                  className={`w-full ${copied.mnemonic ? 'border-green-500 text-green-400' : 'border-red-900/50 text-slate-300'}`}
                >
                  {copied.mnemonic ? (
                    <>
                      <CheckCircle className="w-4 h-4 mr-2" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 mr-2" />
                      Copy Mnemonic
                    </>
                  )}
                </Button>
              </div>

              {/* xpub */}
              <div className="space-y-2">
                <label className="text-xs text-slate-400 uppercase tracking-wider">
                  xpub (set as {walletData.secret_name})
                </label>
                <div className="p-3 bg-black border border-red-900/50 rounded-lg font-mono text-xs text-slate-400 break-all">
                  {walletData.xpub}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleCopy(walletData.xpub, 'xpub')}
                  className={`w-full ${copied.xpub ? 'border-green-500 text-green-400' : 'border-red-900/50 text-slate-300'}`}
                >
                  {copied.xpub ? (
                    <>
                      <CheckCircle className="w-4 h-4 mr-2" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 mr-2" />
                      Copy xpub
                    </>
                  )}
                </Button>
              </div>

              {/* Instructions */}
              <div className="p-3 bg-slate-900/50 border border-slate-700 rounded-lg text-xs text-slate-400">
                <p className="font-semibold text-slate-300 mb-2">Next Steps:</p>
                <ol className="list-decimal list-inside space-y-1">
                  <li>Store the mnemonic securely offline</li>
                  <li>Go to Dashboard → Settings → Environment Variables</li>
                  <li>Add secret: <code className="text-red-400">{walletData.secret_name}</code></li>
                  <li>Paste the xpub as the value</li>
                </ol>
              </div>

              <Button
                onClick={handleClose}
                className="w-full bg-slate-800 hover:bg-slate-700"
              >
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}