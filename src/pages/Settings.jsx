import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { 
  Settings as SettingsIcon, 
  Wallet, 
  Save, 
  CheckCircle, 
  AlertCircle,
  Loader2,
  ShieldCheck,
  MapPin,
  Copy,
  ArrowDownCircle,
  Clock,
  ExternalLink,
  RefreshCw
} from 'lucide-react';
import { toast } from 'sonner';
import WithdrawalControls from '@/components/admin/WithdrawalControls';

export default function Settings() {
  const queryClient = useQueryClient();
  const [ethAddress, setEthAddress] = useState('');
  const [btcAddress, setBtcAddress] = useState('');
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Check admin access
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const me = await base44.auth.me();
        setUser(me);
        if (me?.role !== 'admin') {
          toast.error('Admin access required');
        }
      } catch {
        toast.error('Authentication required');
      } finally {
        setLoading(false);
      }
    };
    checkAuth();
  }, []);

  // Fetch current treasury config
  const { data: treasuryConfig, isLoading: configLoading } = useQuery({
    queryKey: ['treasury-config'],
    queryFn: async () => {
      const res = await base44.functions.invoke('adminProtocol', {
        action: 'get_treasury_addresses'
      });
      return res.data;
    },
    enabled: user?.role === 'admin'
  });

  // Fetch tracked addresses
  const { data: trackedAddresses = [] } = useQuery({
    queryKey: ['tracked-addresses'],
    queryFn: async () => {
      const res = await base44.functions.invoke('adminProtocol', {
        action: 'get_tracked_addresses',
        limit: 200
      });
      return res.data?.addresses || [];
    },
    enabled: user?.role === 'admin'
  });

  // Fetch pending deposits
  const { data: deposits = [] } = useQuery({
    queryKey: ['pending-deposits'],
    queryFn: async () => {
      const res = await base44.functions.invoke('adminProtocol', {
        action: 'get_deposits',
        limit: 100
      });
      return res.data?.deposits || [];
    },
    enabled: user?.role === 'admin'
  });

  // Update form when config loads
  useEffect(() => {
    if (treasuryConfig) {
      setEthAddress(treasuryConfig.eth_treasury_address || '');
      setBtcAddress(treasuryConfig.btc_treasury_address || '');
    }
  }, [treasuryConfig]);

  // Reconcile mutation
  const reconcileMutation = useMutation({
    mutationFn: async () => {
      const res = await base44.functions.invoke('reconcileDeposits', {});
      if (res.data.error) throw new Error(res.data.error);
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['pending-deposits'] });
      toast.success(`Reconciled: ${data.deposits_new} new, ${data.deposits_credited} credited`);
    },
    onError: (err) => toast.error(err.message || 'Reconciliation failed')
  });

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await base44.functions.invoke('adminProtocol', {
        action: 'set_treasury_addresses',
        eth_treasury_address: ethAddress,
        btc_treasury_address: btcAddress || null
      });
      if (res.data.error) {
        throw new Error(res.data.error);
      }
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['treasury-config'] });
      toast.success('Treasury addresses saved');
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to save');
    }
  });

  if (loading || configLoading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-red-500 animate-spin" />
      </div>
    );
  }

  if (user?.role !== 'admin') {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <ShieldCheck className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <p className="text-slate-400">Admin access required</p>
          <Link to={createPageUrl('Dashboard')} className="text-red-500 hover:underline mt-2 block">
            Return to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  const ethValid = /^0x[a-fA-F0-9]{40}$/.test(ethAddress);
  const btcValid = !btcAddress || /^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(btcAddress) || /^bc1[a-z0-9]{39,59}$/.test(btcAddress);
  const isEthLocked = treasuryConfig?.treasury_ready === true;
  const isBtcLocked = treasuryConfig?.btc_treasury_address && treasuryConfig?.validation?.btc_valid;

  return (
    <div className="min-h-screen bg-black text-slate-100">
      {/* Header */}
      <header className="border-b border-red-900/50 bg-slate-950/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link to={createPageUrl('Home')} className="p-2 bg-red-600/20 rounded-xl hover:bg-red-600/30 transition-colors">
                <img 
                  src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/697d1be0c667d4dce44a946b/6065d4cd3_clawdslist.png" 
                  alt="ClawdsList" 
                  className="w-6 h-6"
                />
              </Link>
              <div>
                <h1 className="text-xl font-bold text-red-500">Settings</h1>
                <p className="text-xs text-slate-500">Protocol Configuration</p>
              </div>
            </div>
            <nav className="flex items-center gap-1">
              {[
                { name: 'Dashboard', page: 'Dashboard' },
                { name: 'Revenue', page: 'ProtocolRevenue' },
                { name: 'Settings', page: 'Settings', active: true }
              ].map(item => (
                <Link
                  key={item.page}
                  to={createPageUrl(item.page)}
                  className={`px-3 py-2 text-sm rounded transition-colors ${
                    item.active 
                      ? 'bg-slate-900 text-red-400' 
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
                  }`}
                >
                  {item.name}
                </Link>
              ))}
            </nav>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        {/* Withdrawal Controls */}
        <WithdrawalControls />

        {/* Treasury Section */}
        <div className="mt-6 bg-slate-950 border border-red-900/50 rounded-lg">
          <div className="p-4 border-b border-red-900/30 flex items-center gap-3">
            <Wallet className="w-5 h-5 text-red-500" />
            <div>
              <h2 className="text-lg text-slate-100">Treasury Addresses</h2>
              <p className="text-xs text-slate-500">Configure protocol fee sweep destinations</p>
            </div>
          </div>

          <div className="p-6 space-y-6">
            {/* Status Banner */}
            {treasuryConfig && (
              <div className={`p-3 rounded-lg border flex items-center gap-3 ${
                treasuryConfig.treasury_ready 
                  ? 'bg-green-900/20 border-green-900/50' 
                  : 'bg-red-900/20 border-red-900/50'
              }`}>
                {treasuryConfig.treasury_ready ? (
                  <>
                    <CheckCircle className="w-5 h-5 text-green-500" />
                    <span className="text-sm text-green-400">Treasury configured - addresses locked</span>
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-5 h-5 text-red-500" />
                    <span className="text-sm text-red-400">Treasury not configured - sweeps disabled</span>
                  </>
                )}
              </div>
            )}

            {/* ETH Address */}
            <div className="space-y-2">
              <Label className="text-slate-300">
                ETH Treasury Address <span className="text-red-500">*</span>
              </Label>
              <div className="relative">
                <Input
                  value={ethAddress}
                  onChange={(e) => setEthAddress(e.target.value)}
                  placeholder="0x..."
                  disabled={isEthLocked}
                  className={`bg-black border-red-900/50 text-slate-100 font-mono text-sm ${
                    ethAddress && !ethValid ? 'border-red-500' : ''
                  } ${isEthLocked ? 'opacity-60 cursor-not-allowed' : ''}`}
                />
                {ethAddress && (
                  <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-xs ${
                    ethValid ? 'text-green-500' : 'text-red-500'
                  }`}>
                    {ethValid ? '✓ Valid' : '✗ Invalid'}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500">
                {isEthLocked ? 'Address is locked and cannot be changed' : 'Required. Format: 0x + 40 hex characters'}
              </p>
            </div>

            {/* BTC Address */}
            <div className="space-y-2">
              <Label className="text-slate-300">
                BTC Treasury Address <span className="text-slate-500">(optional)</span>
              </Label>
              <div className="relative">
                <Input
                  value={btcAddress}
                  onChange={(e) => setBtcAddress(e.target.value)}
                  placeholder="1... or 3... or bc1..."
                  disabled={isBtcLocked}
                  className={`bg-black border-red-900/50 text-slate-100 font-mono text-sm ${
                    btcAddress && !btcValid ? 'border-red-500' : ''
                  } ${isBtcLocked ? 'opacity-60 cursor-not-allowed' : ''}`}
                />
                {btcAddress && (
                  <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-xs ${
                    btcValid ? 'text-green-500' : 'text-red-500'
                  }`}>
                    {btcValid ? '✓ Valid' : '✗ Invalid'}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500">
                {isBtcLocked ? 'Address is locked and cannot be changed' : 'Supports P2PKH (1...), P2SH (3...), and Bech32 (bc1...)'}
              </p>
            </div>

            {/* Save Button */}
            {(!isEthLocked || !isBtcLocked) && (
              <div className="pt-4 border-t border-red-900/30">
                <Button
                  onClick={() => saveMutation.mutate()}
                  disabled={!ethValid || !btcValid || saveMutation.isPending}
                  className="bg-red-600 hover:bg-red-700 text-white"
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  {isEthLocked ? 'Save BTC Address' : 'Save Treasury Addresses'}
                </Button>
              </div>
            )}

            {/* Last Updated */}
            {treasuryConfig?.updated_at && (
              <p className="text-xs text-slate-600">
                Last updated: {new Date(treasuryConfig.updated_at).toLocaleString()}
              </p>
            )}
          </div>
        </div>

        {/* Tracked Addresses Section */}
        <div className="mt-6 bg-slate-950 border border-red-900/50 rounded-lg">
          <div className="p-4 border-b border-red-900/30 flex items-center gap-3">
            <MapPin className="w-5 h-5 text-red-500" />
            <div>
              <h2 className="text-lg text-slate-100">Tracked Addresses</h2>
              <p className="text-xs text-slate-500">Addresses registered for deposit monitoring</p>
            </div>
            <span className="ml-auto text-xs text-slate-500">{trackedAddresses.length} registered</span>
          </div>

          <div className="divide-y divide-red-900/30 max-h-64 overflow-y-auto">
            {trackedAddresses.length === 0 ? (
              <div className="p-6 text-center text-slate-500 text-sm">
                No tracked addresses yet
              </div>
            ) : (
              trackedAddresses.map((addr) => (
                <div key={addr.id} className="p-3 flex items-center gap-3 hover:bg-slate-900/30">
                  <span className={`px-2 py-0.5 text-xs rounded ${
                    addr.chain === 'ETH' ? 'bg-blue-900/50 text-blue-400' : 'bg-orange-900/50 text-orange-400'
                  }`}>
                    {addr.chain}
                  </span>
                  <span className={`px-2 py-0.5 text-xs rounded ${
                    addr.owner_type === 'protocol' ? 'bg-red-900/50 text-red-400' : 'bg-green-900/50 text-green-400'
                  }`}>
                    {addr.owner_type}
                  </span>
                  <span className={`px-2 py-0.5 text-xs rounded ${
                    addr.purpose === 'treasury' ? 'bg-purple-900/50 text-purple-400' : 'bg-cyan-900/50 text-cyan-400'
                  }`}>
                    {addr.purpose}
                  </span>
                  <code className="flex-1 font-mono text-xs text-slate-400 truncate">
                    {addr.address}
                  </code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(addr.address);
                      toast.success('Address copied');
                    }}
                    className="p-1 text-slate-500 hover:text-slate-300"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  {addr.owner_id && (
                    <span className="text-xs text-slate-600 truncate max-w-[80px]" title={addr.owner_id}>
                      {addr.owner_id.slice(0, 8)}...
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Pending Deposits Section */}
        <div className="mt-6 bg-slate-950 border border-red-900/50 rounded-lg">
          <div className="p-4 border-b border-red-900/30 flex items-center gap-3">
            <ArrowDownCircle className="w-5 h-5 text-red-500" />
            <div>
              <h2 className="text-lg text-slate-100">Deposits</h2>
              <p className="text-xs text-slate-500">Incoming deposits from Tatum webhooks</p>
            </div>
            <span className="text-xs text-slate-500">{deposits.length} total</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => reconcileMutation.mutate()}
              disabled={reconcileMutation.isPending}
              className="ml-auto border-red-900/50 text-slate-300 hover:bg-red-900/20"
            >
              {reconcileMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              )}
              Reconcile
            </Button>
          </div>

          <div className="divide-y divide-red-900/30 max-h-80 overflow-y-auto">
            {deposits.length === 0 ? (
              <div className="p-6 text-center text-slate-500 text-sm">
                No deposits yet
              </div>
            ) : (
              deposits.map((dep) => (
                <div key={dep.id} className="p-3 hover:bg-slate-900/30">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 text-xs rounded ${
                      dep.chain === 'ETH' ? 'bg-blue-900/50 text-blue-400' : 'bg-orange-900/50 text-orange-400'
                    }`}>
                      {dep.chain}
                    </span>
                    <span className={`px-2 py-0.5 text-xs rounded ${
                      dep.status === 'credited' ? 'bg-green-900/50 text-green-400' :
                      dep.status === 'confirming' ? 'bg-yellow-900/50 text-yellow-400' :
                      dep.status === 'ignored' ? 'bg-slate-700/50 text-slate-400' :
                      'bg-blue-900/50 text-blue-400'
                    }`}>
                      {dep.status}
                    </span>
                    <span className="text-sm text-slate-200 font-mono">
                      {dep.amount} {dep.chain}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-slate-500">
                      <Clock className="w-3 h-3" />
                      {dep.confirmations}/{dep.chain === 'ETH' ? 12 : 3}
                    </span>
                    {dep.owner_type && (
                      <span className={`px-2 py-0.5 text-xs rounded ${
                        dep.owner_type === 'protocol' ? 'bg-red-900/50 text-red-400' : 'bg-green-900/50 text-green-400'
                      }`}>
                        {dep.owner_type}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-slate-600">
                      {new Date(dep.first_seen_at || dep.created_date).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="font-mono text-xs text-slate-500 truncate flex-1">
                      tx: {dep.tx_hash}
                    </code>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(dep.tx_hash);
                        toast.success('TX hash copied');
                      }}
                      className="p-1 text-slate-500 hover:text-slate-300"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <a
                      href={dep.chain === 'ETH' 
                        ? `https://etherscan.io/tx/${dep.tx_hash}`
                        : `https://mempool.space/tx/${dep.tx_hash}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1 text-slate-500 hover:text-slate-300"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                  <code className="block mt-1 font-mono text-xs text-slate-600 truncate">
                    addr: {dep.address}
                  </code>
                </div>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}