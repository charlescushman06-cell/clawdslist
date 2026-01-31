import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  Wallet,
  TrendingUp,
  Clock,
  ArrowUpRight,
  RefreshCw,
  ChevronRight,
  Send,
  ExternalLink
} from 'lucide-react';
import { format, subDays, subHours } from 'date-fns';

export default function ProtocolRevenue() {
  const [chainFilter, setChainFilter] = useState('all');
  const [limit, setLimit] = useState(50);
  const [sweepChainFilter, setSweepChainFilter] = useState('all');
  const [sweepStatusFilter, setSweepStatusFilter] = useState('all');

  const { data: balances, isLoading: balancesLoading, refetch: refetchBalances } = useQuery({
    queryKey: ['protocol-balances'],
    queryFn: async () => {
      const response = await base44.functions.invoke('adminProtocol', {
        action: 'get_balances'
      });
      return response.data;
    }
  });

  const { data: ledgerData, isLoading: ledgerLoading, refetch: refetchLedger } = useQuery({
    queryKey: ['protocol-ledger', chainFilter, limit],
    queryFn: async () => {
      const response = await base44.functions.invoke('adminProtocol', {
        action: 'get_ledger_entries',
        chain: chainFilter === 'all' ? undefined : chainFilter,
        limit
      });
      return response.data;
    }
  });

  const { data: statsData } = useQuery({
    queryKey: ['protocol-stats'],
    queryFn: async () => {
      const response = await base44.functions.invoke('adminProtocol', {
        action: 'get_stats'
      });
      return response.data;
    }
  });

  const { data: sweepsData, isLoading: sweepsLoading, refetch: refetchSweeps } = useQuery({
    queryKey: ['protocol-sweeps', sweepChainFilter, sweepStatusFilter],
    queryFn: async () => {
      const response = await base44.functions.invoke('adminProtocol', {
        action: 'list_sweeps',
        chain: sweepChainFilter === 'all' ? undefined : sweepChainFilter,
        status: sweepStatusFilter === 'all' ? undefined : sweepStatusFilter,
        limit: 50
      });
      return response.data;
    }
  });

  const handleRefresh = () => {
    refetchBalances();
    refetchLedger();
    refetchSweeps();
  };

  const formatAmount = (amount) => {
    if (!amount) return '0.00';
    const num = parseFloat(amount);
    return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  };

  return (
    <div className="min-h-screen bg-black text-slate-100">
      {/* Header */}
      <header className="border-b border-red-900/50 bg-slate-950/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link to={createPageUrl('Dashboard')} className="p-2 bg-red-600/20 rounded-xl">
                <img 
                  src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/697d1be0c667d4dce44a946b/6065d4cd3_clawdslist.png" 
                  alt="ClawdsList" 
                  className="w-6 h-6"
                />
              </Link>
              <div>
                <h1 className="text-xl font-bold text-red-500">Protocol Revenue</h1>
                <p className="text-xs text-slate-500">Fee Accruals & Balances</p>
              </div>
            </div>
            <nav className="flex items-center gap-1">
              {[
                { name: 'Home', page: 'Home', special: true },
                { name: 'Dashboard', page: 'Dashboard' },
                { name: 'Tasks', page: 'Tasks' },
                { name: 'Workers', page: 'Workers' },
                { name: 'Revenue', page: 'ProtocolRevenue', active: true },
                { name: 'API Docs', page: 'ApiDocs' }
              ].map(item => (
                <Link
                  key={item.page}
                  to={createPageUrl(item.page)}
                  className={`px-3 py-2 text-sm rounded transition-colors ${
                    item.active 
                      ? 'bg-slate-900 text-red-400' 
                      : item.special
                      ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30'
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

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg text-slate-200">Protocol Balances</h2>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleRefresh}
            className="border-red-900/50 text-slate-300 hover:bg-slate-900"
          >
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
        </div>

        {/* Balance Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {['ETH', 'BTC'].map(chain => (
            <React.Fragment key={chain}>
              <div className="bg-slate-950 border border-red-900/50 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Wallet className="w-4 h-4 text-red-500" />
                  <span className="text-xs uppercase text-slate-500">{chain} Available</span>
                </div>
                <p className="text-2xl font-bold text-slate-100">
                  {balancesLoading ? '...' : formatAmount(balances?.[chain]?.available_balance)}
                </p>
                <p className="text-xs text-slate-500 mt-1">USD</p>
              </div>
              <div className="bg-slate-950 border border-red-900/50 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Clock className="w-4 h-4 text-amber-500" />
                  <span className="text-xs uppercase text-slate-500">{chain} Locked</span>
                </div>
                <p className="text-2xl font-bold text-slate-100">
                  {balancesLoading ? '...' : formatAmount(balances?.[chain]?.locked_balance)}
                </p>
                <p className="text-xs text-slate-500 mt-1">USD</p>
              </div>
            </React.Fragment>
          ))}
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          <div className="bg-slate-950 border border-red-900/50 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-emerald-500" />
              <span className="text-xs uppercase text-slate-500">Last 24 Hours</span>
            </div>
            <p className="text-2xl font-bold text-emerald-400">
              +{formatAmount(statsData?.last_24h || '0')}
            </p>
            <p className="text-xs text-slate-500 mt-1">USD accrued</p>
          </div>
          <div className="bg-slate-950 border border-red-900/50 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-emerald-500" />
              <span className="text-xs uppercase text-slate-500">Last 7 Days</span>
            </div>
            <p className="text-2xl font-bold text-emerald-400">
              +{formatAmount(statsData?.last_7d || '0')}
            </p>
            <p className="text-xs text-slate-500 mt-1">USD accrued</p>
          </div>
        </div>

        {/* Sweep History */}
        <div className="bg-slate-950 border border-red-900/50 rounded-lg mb-8">
          <div className="flex items-center justify-between p-4 border-b border-red-900/30">
            <div className="flex items-center gap-2">
              <Send className="w-4 h-4 text-red-500" />
              <h3 className="text-sm uppercase tracking-wider text-slate-400">Sweep History</h3>
            </div>
            <div className="flex items-center gap-3">
              <Select value={sweepChainFilter} onValueChange={setSweepChainFilter}>
                <SelectTrigger className="w-28 bg-slate-900 border-red-900/50 text-slate-100 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-red-900/50">
                  <SelectItem value="all" className="text-slate-100">All Chains</SelectItem>
                  <SelectItem value="ETH" className="text-slate-100">ETH</SelectItem>
                  <SelectItem value="BTC" className="text-slate-100">BTC</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sweepStatusFilter} onValueChange={setSweepStatusFilter}>
                <SelectTrigger className="w-32 bg-slate-900 border-red-900/50 text-slate-100 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-red-900/50">
                  <SelectItem value="all" className="text-slate-100">All Status</SelectItem>
                  <SelectItem value="requested" className="text-slate-100">Requested</SelectItem>
                  <SelectItem value="broadcasted" className="text-slate-100">Broadcasted</SelectItem>
                  <SelectItem value="confirmed" className="text-slate-100">Confirmed</SelectItem>
                  <SelectItem value="failed" className="text-slate-100">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-red-900/30 bg-slate-950">
                  <th className="text-left p-4 text-xs uppercase tracking-wider text-slate-500">Date</th>
                  <th className="text-left p-4 text-xs uppercase tracking-wider text-slate-500">Chain</th>
                  <th className="text-right p-4 text-xs uppercase tracking-wider text-slate-500">Amount</th>
                  <th className="text-left p-4 text-xs uppercase tracking-wider text-slate-500">Destination</th>
                  <th className="text-left p-4 text-xs uppercase tracking-wider text-slate-500">Status</th>
                  <th className="text-left p-4 text-xs uppercase tracking-wider text-slate-500">Tx Hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-red-900/30">
                {sweepsLoading ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-500">Loading...</td>
                  </tr>
                ) : sweepsData?.sweeps?.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-500">No sweeps yet</td>
                  </tr>
                ) : (
                  sweepsData?.sweeps?.map(sweep => (
                    <tr key={sweep.id} className="hover:bg-slate-900/30 transition-colors">
                      <td className="p-4 text-sm text-slate-300">
                        {format(new Date(sweep.created_date), 'MMM d, HH:mm')}
                      </td>
                      <td className="p-4">
                        <span className={`px-2 py-1 text-xs rounded ${
                          sweep.chain === 'ETH' 
                            ? 'bg-blue-900/30 text-blue-400' 
                            : 'bg-amber-900/30 text-amber-400'
                        }`}>
                          {sweep.chain}
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        <span className="text-red-400 font-mono text-sm">
                          -{formatAmount(sweep.amount)}
                        </span>
                      </td>
                      <td className="p-4">
                        <span className="text-xs text-slate-500 font-mono">
                          {sweep.destination_address?.slice(0, 10)}...{sweep.destination_address?.slice(-6)}
                        </span>
                      </td>
                      <td className="p-4">
                        <span className={`px-2 py-1 text-xs rounded ${
                          sweep.status === 'confirmed' ? 'bg-emerald-900/30 text-emerald-400' :
                          sweep.status === 'broadcasted' ? 'bg-blue-900/30 text-blue-400' :
                          sweep.status === 'failed' ? 'bg-red-900/30 text-red-400' :
                          'bg-amber-900/30 text-amber-400'
                        }`}>
                          {sweep.status}
                        </span>
                      </td>
                      <td className="p-4">
                        {sweep.tx_hash ? (
                          <a 
                            href={sweep.chain === 'ETH' 
                              ? `https://etherscan.io/tx/${sweep.tx_hash}` 
                              : `https://blockstream.info/tx/${sweep.tx_hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-red-400 text-xs hover:text-red-300 flex items-center gap-1 font-mono"
                          >
                            {sweep.tx_hash.slice(0, 10)}... <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : (
                          <span className="text-xs text-slate-600">-</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Ledger Entries */}
        <div className="bg-slate-950 border border-red-900/50 rounded-lg">
          <div className="flex items-center justify-between p-4 border-b border-red-900/30">
            <h3 className="text-sm uppercase tracking-wider text-slate-400">Fee Accrual History</h3>
            <div className="flex items-center gap-3">
              <Select value={chainFilter} onValueChange={setChainFilter}>
                <SelectTrigger className="w-28 bg-slate-900 border-red-900/50 text-slate-100 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-red-900/50">
                  <SelectItem value="all" className="text-slate-100">All Chains</SelectItem>
                  <SelectItem value="ETH" className="text-slate-100">ETH</SelectItem>
                  <SelectItem value="BTC" className="text-slate-100">BTC</SelectItem>
                </SelectContent>
              </Select>
              <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
                <SelectTrigger className="w-24 bg-slate-900 border-red-900/50 text-slate-100 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-red-900/50">
                  <SelectItem value="25" className="text-slate-100">25</SelectItem>
                  <SelectItem value="50" className="text-slate-100">50</SelectItem>
                  <SelectItem value="100" className="text-slate-100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-red-900/30 bg-slate-950">
                  <th className="text-left p-4 text-xs uppercase tracking-wider text-slate-500">Date</th>
                  <th className="text-left p-4 text-xs uppercase tracking-wider text-slate-500">Chain</th>
                  <th className="text-left p-4 text-xs uppercase tracking-wider text-slate-500">Type</th>
                  <th className="text-right p-4 text-xs uppercase tracking-wider text-slate-500">Amount</th>
                  <th className="text-left p-4 text-xs uppercase tracking-wider text-slate-500">Task</th>
                  <th className="text-left p-4 text-xs uppercase tracking-wider text-slate-500">Event</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-red-900/30">
                {ledgerLoading ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-500">Loading...</td>
                  </tr>
                ) : ledgerData?.entries?.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-500">No fee accruals yet</td>
                  </tr>
                ) : (
                  ledgerData?.entries?.map(entry => (
                    <tr key={entry.id} className="hover:bg-slate-900/30 transition-colors">
                      <td className="p-4 text-sm text-slate-300">
                        {format(new Date(entry.created_date), 'MMM d, HH:mm')}
                      </td>
                      <td className="p-4">
                        <span className={`px-2 py-1 text-xs rounded ${
                          entry.chain === 'ETH' 
                            ? 'bg-blue-900/30 text-blue-400' 
                            : 'bg-amber-900/30 text-amber-400'
                        }`}>
                          {entry.chain}
                        </span>
                      </td>
                      <td className="p-4 text-sm text-slate-400">
                        {entry.entry_type === 'protocol_fee_accrual' ? 'Fee Accrual' : entry.entry_type}
                      </td>
                      <td className="p-4 text-right">
                        <span className="text-emerald-400 font-mono text-sm">
                          +{formatAmount(entry.amount)}
                        </span>
                      </td>
                      <td className="p-4">
                        {entry.related_task_id ? (
                          <span className="text-xs text-slate-500 font-mono">
                            {entry.related_task_id.slice(0, 8)}...
                          </span>
                        ) : '-'}
                      </td>
                      <td className="p-4">
                        {entry.event_id ? (
                          <Link 
                            to={createPageUrl(`Events?id=${entry.event_id}`)}
                            className="text-red-400 text-xs hover:text-red-300 flex items-center gap-1"
                          >
                            View <ChevronRight className="w-3 h-3" />
                          </Link>
                        ) : (
                          <span className="text-xs text-slate-600">-</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}