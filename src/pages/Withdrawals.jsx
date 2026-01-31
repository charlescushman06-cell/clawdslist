import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  ArrowDownCircle,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  Send,
  Loader2,
  ExternalLink,
  Shield,
  Filter
} from 'lucide-react';

const STATUS_STYLES = {
  requested: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  risk_hold: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  approved: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  broadcasted: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  confirmed: 'bg-green-500/20 text-green-400 border-green-500/30',
  rejected: 'bg-red-500/20 text-red-400 border-red-500/30',
  failed: 'bg-red-500/20 text-red-400 border-red-500/30'
};

const STATUS_ICONS = {
  requested: Clock,
  risk_hold: AlertTriangle,
  approved: CheckCircle,
  broadcasted: Send,
  confirmed: CheckCircle,
  rejected: XCircle,
  failed: XCircle
};

export default function Withdrawals() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('all');
  const [chainFilter, setChainFilter] = useState('all');
  const [reviewDialog, setReviewDialog] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  const { data: withdrawals = [], isLoading } = useQuery({
    queryKey: ['admin-withdrawals', statusFilter, chainFilter],
    queryFn: async () => {
      const filter = {};
      if (statusFilter !== 'all') filter.status = statusFilter;
      if (chainFilter !== 'all') filter.chain = chainFilter;
      
      const res = await base44.functions.invoke('withdrawalRisk', {
        action: 'list_withdrawals',
        ...filter,
        limit: 100
      });
      return res.data?.withdrawals || [];
    }
  });

  const { data: config } = useQuery({
    queryKey: ['withdrawal-config'],
    queryFn: async () => {
      const res = await base44.functions.invoke('withdrawalRisk', {
        action: 'get_config'
      });
      return res.data;
    }
  });

  const reviewMutation = useMutation({
    mutationFn: async ({ withdrawal_id, decision, reason }) => {
      const res = await base44.functions.invoke('withdrawalRisk', {
        action: 'admin_review',
        withdrawal_id,
        decision,
        reason
      });
      if (res.data?.error) throw new Error(res.data.error);
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['admin-withdrawals'] });
      toast.success(`Withdrawal ${data.status}`);
      setReviewDialog(null);
      setRejectReason('');
    },
    onError: (err) => toast.error(err.message)
  });

  const handleApprove = (withdrawal) => {
    reviewMutation.mutate({
      withdrawal_id: withdrawal.id,
      decision: 'approve'
    });
  };

  const handleReject = () => {
    if (!reviewDialog) return;
    reviewMutation.mutate({
      withdrawal_id: reviewDialog.id,
      decision: 'reject',
      reason: rejectReason || 'Rejected by admin'
    });
  };

  const getExplorerUrl = (chain, txHash) => {
    if (!txHash) return null;
    if (chain === 'ETH') {
      return `https://etherscan.io/tx/${txHash}`;
    }
    return `https://blockstream.info/tx/${txHash}`;
  };

  const counts = {
    risk_hold: withdrawals.filter(w => w.status === 'risk_hold').length,
    requested: withdrawals.filter(w => w.status === 'requested').length,
    approved: withdrawals.filter(w => w.status === 'approved').length
  };

  return (
    <div className="min-h-screen bg-black text-slate-100">
      {/* Header */}
      <header className="border-b border-red-900/50 bg-slate-950/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-600/20 rounded-xl">
                <ArrowDownCircle className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-red-500">Withdrawals</h1>
                <p className="text-xs text-slate-500">Review and manage withdrawal requests</p>
              </div>
            </div>
            <nav className="flex items-center gap-1">
              {[
                { name: 'Dashboard', page: 'Dashboard' },
                { name: 'Withdrawals', page: 'Withdrawals', active: true },
                { name: 'Settings', page: 'Settings' }
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

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-4">
            <div className="flex items-center gap-2 text-orange-400 mb-1">
              <AlertTriangle className="w-4 h-4" />
              <span className="text-sm">Risk Hold</span>
            </div>
            <p className="text-2xl font-bold text-orange-400">{counts.risk_hold}</p>
          </div>
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4">
            <div className="flex items-center gap-2 text-yellow-400 mb-1">
              <Clock className="w-4 h-4" />
              <span className="text-sm">Pending</span>
            </div>
            <p className="text-2xl font-bold text-yellow-400">{counts.requested}</p>
          </div>
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
            <div className="flex items-center gap-2 text-blue-400 mb-1">
              <CheckCircle className="w-4 h-4" />
              <span className="text-sm">Approved</span>
            </div>
            <p className="text-2xl font-bold text-blue-400">{counts.approved}</p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4 mb-6">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-slate-500" />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40 bg-slate-950 border-red-900/50">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="risk_hold">Risk Hold</SelectItem>
                <SelectItem value="requested">Requested</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="broadcasted">Broadcasted</SelectItem>
                <SelectItem value="confirmed">Confirmed</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Select value={chainFilter} onValueChange={setChainFilter}>
            <SelectTrigger className="w-32 bg-slate-950 border-red-900/50">
              <SelectValue placeholder="Chain" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Chains</SelectItem>
              <SelectItem value="ETH">ETH</SelectItem>
              <SelectItem value="BTC">BTC</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Config Info */}
        {config && (
          <div className="bg-slate-950 border border-red-900/30 rounded-lg p-4 mb-6">
            <div className="flex items-center gap-2 text-slate-400 mb-2">
              <Shield className="w-4 h-4" />
              <span className="text-xs uppercase tracking-wider">Auto-Approval Limits</span>
            </div>
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <span className="text-slate-500">ETH:</span>{' '}
                <span className="text-slate-300">Max {config.ETH?.AUTO_WITHDRAW_MAX}, Daily {config.ETH?.DAILY_MAX}</span>
              </div>
              <div>
                <span className="text-slate-500">BTC:</span>{' '}
                <span className="text-slate-300">Max {config.BTC?.AUTO_WITHDRAW_MAX}, Daily {config.BTC?.DAILY_MAX}</span>
              </div>
            </div>
          </div>
        )}

        {/* Withdrawals List */}
        <div className="bg-slate-950 border border-red-900/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center">
              <Loader2 className="w-6 h-6 animate-spin text-red-500 mx-auto" />
            </div>
          ) : withdrawals.length === 0 ? (
            <div className="p-8 text-center text-slate-500">
              No withdrawals found
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-red-900/30 text-xs uppercase text-slate-500">
                  <th className="text-left p-4">Worker</th>
                  <th className="text-left p-4">Chain</th>
                  <th className="text-left p-4">Amount</th>
                  <th className="text-left p-4">Destination</th>
                  <th className="text-left p-4">Status</th>
                  <th className="text-left p-4">Risk</th>
                  <th className="text-left p-4">Date</th>
                  <th className="text-right p-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-red-900/30">
                {withdrawals.map(w => {
                  const StatusIcon = STATUS_ICONS[w.status] || Clock;
                  const explorerUrl = getExplorerUrl(w.chain, w.tx_hash);
                  
                  return (
                    <tr key={w.id} className="hover:bg-slate-900/30">
                      <td className="p-4">
                        <span className="text-sm text-slate-300">{w.worker_name}</span>
                      </td>
                      <td className="p-4">
                        <span className={`px-2 py-1 text-xs rounded ${
                          w.chain === 'ETH' ? 'bg-blue-500/20 text-blue-400' : 'bg-orange-500/20 text-orange-400'
                        }`}>
                          {w.chain}
                        </span>
                      </td>
                      <td className="p-4 font-mono text-sm text-slate-300">
                        {w.amount}
                      </td>
                      <td className="p-4">
                        <span className="font-mono text-xs text-slate-400">
                          {w.destination_address?.slice(0, 10)}...{w.destination_address?.slice(-8)}
                        </span>
                      </td>
                      <td className="p-4">
                        <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded border ${STATUS_STYLES[w.status]}`}>
                          <StatusIcon className="w-3 h-3" />
                          {w.status}
                        </span>
                      </td>
                      <td className="p-4">
                        {w.risk_score > 0 ? (
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-mono ${
                              w.risk_score >= 50 ? 'text-red-400' : 
                              w.risk_score >= 25 ? 'text-orange-400' : 'text-yellow-400'
                            }`}>
                              {w.risk_score}
                            </span>
                            {w.risk_reasons?.length > 0 && (
                              <span className="text-xs text-slate-500" title={w.risk_reasons.map(r => r.message).join('\n')}>
                                ({w.risk_reasons.length} flags)
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-sm text-green-400">0</span>
                        )}
                      </td>
                      <td className="p-4 text-xs text-slate-500">
                        {new Date(w.created_date).toLocaleDateString()}
                      </td>
                      <td className="p-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {explorerUrl && (
                            <a
                              href={explorerUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1 text-slate-500 hover:text-slate-300"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          )}
                          {['requested', 'risk_hold'].includes(w.status) && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleApprove(w)}
                                disabled={reviewMutation.isPending}
                                className="border-green-500/50 text-green-400 hover:bg-green-500/20"
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setReviewDialog(w)}
                                disabled={reviewMutation.isPending}
                                className="border-red-500/50 text-red-400 hover:bg-red-500/20"
                              >
                                Reject
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>

      {/* Reject Dialog */}
      <Dialog open={!!reviewDialog} onOpenChange={() => setReviewDialog(null)}>
        <DialogContent className="bg-slate-950 border-red-900/50">
          <DialogHeader>
            <DialogTitle className="text-slate-100">Reject Withdrawal</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="text-sm text-slate-400">
              Rejecting withdrawal of <span className="text-slate-200 font-mono">{reviewDialog?.amount} {reviewDialog?.chain}</span> for worker <span className="text-slate-200">{reviewDialog?.worker_name}</span>
            </div>
            <Textarea
              placeholder="Rejection reason (optional)"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              className="bg-slate-900 border-red-900/50"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleReject}
              disabled={reviewMutation.isPending}
              className="bg-red-600 hover:bg-red-700"
            >
              {reviewMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}