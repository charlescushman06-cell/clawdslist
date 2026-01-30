import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import StatusBadge from '@/components/admin/StatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { 
  Search,
  Waves,
  CheckCircle,
  XCircle,
  Eye,
  Clock
} from 'lucide-react';
import { format } from 'date-fns';

export default function Submissions() {
  const queryClient = useQueryClient();
  const [selectedSubmission, setSelectedSubmission] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [reviewNotes, setReviewNotes] = useState('');

  const { data: submissions = [] } = useQuery({
    queryKey: ['submissions'],
    queryFn: () => base44.entities.Submission.list('-created_date', 200)
  });

  const { data: workers = [] } = useQuery({
    queryKey: ['workers'],
    queryFn: () => base44.entities.Worker.list()
  });

  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => base44.entities.Task.list()
  });

  const reviewMutation = useMutation({
    mutationFn: async ({ id, status, notes }) => {
      const submission = submissions.find(s => s.id === id);
      
      // Update submission
      await base44.entities.Submission.update(id, {
        status,
        review_notes: notes,
        reviewed_at: new Date().toISOString()
      });

      // Update worker stats
      if (submission?.worker_id) {
        const worker = workers.find(w => w.id === submission.worker_id);
        if (worker) {
          const task = tasks.find(t => t.id === submission.task_id);
          let updates = {};
          
          if (status === 'approved') {
            updates.tasks_completed = (worker.tasks_completed || 0) + 1;
            updates.total_credits_earned = (worker.total_credits_earned || 0) + (task?.reward_credits || 0);
          } else if (status === 'rejected') {
            updates.tasks_rejected = (worker.tasks_rejected || 0) + 1;
          }

          // Recalculate reputation
          const completed = status === 'approved' ? (worker.tasks_completed || 0) + 1 : (worker.tasks_completed || 0);
          const rejected = status === 'rejected' ? (worker.tasks_rejected || 0) + 1 : (worker.tasks_rejected || 0);
          const expired = worker.tasks_expired || 0;
          const total = completed + rejected + expired;
          
          if (total > 0) {
            const successRate = completed / total;
            const penaltyRate = (rejected * 2 + expired) / total;
            updates.reputation_score = Math.max(0, Math.min(100, Math.round(successRate * 100 - penaltyRate * 20)));
          }

          await base44.entities.Worker.update(worker.id, updates);
        }
      }

      // Log event
      await base44.entities.Event.create({
        event_type: status === 'approved' ? 'submission_approved' : 'submission_rejected',
        entity_type: 'submission',
        entity_id: id,
        actor_type: 'admin',
        actor_id: 'admin',
        details: JSON.stringify({ notes })
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['submissions']);
      queryClient.invalidateQueries(['workers']);
      setSelectedSubmission(null);
      setReviewNotes('');
    }
  });

  const filteredSubmissions = submissions.filter(sub => {
    const matchesSearch = !search || 
      sub.task_title?.toLowerCase().includes(search.toLowerCase()) ||
      sub.worker_name?.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'all' || sub.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleApprove = () => {
    if (selectedSubmission) {
      reviewMutation.mutate({ id: selectedSubmission.id, status: 'approved', notes: reviewNotes });
    }
  };

  const handleReject = () => {
    if (selectedSubmission) {
      reviewMutation.mutate({ id: selectedSubmission.id, status: 'rejected', notes: reviewNotes });
    }
  };

  const formatOutput = (output) => {
    try {
      return JSON.stringify(JSON.parse(output), null, 2);
    } catch {
      return output;
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link to={createPageUrl('Dashboard')} className="p-2 bg-amber-600/20 rounded-lg hover:bg-amber-600/30 transition-colors">
                <Waves className="w-6 h-6 text-amber-500" />
              </Link>
              <div>
                <h1 className="text-xl font-mono font-bold text-slate-100">Submissions</h1>
                <p className="text-xs text-slate-500 font-mono">Review & Approve</p>
              </div>
            </div>
            <nav className="flex items-center gap-1">
              {[
                { name: 'Dashboard', page: 'Dashboard' },
                { name: 'Tasks', page: 'Tasks' },
                { name: 'Workers', page: 'Workers' },
                { name: 'Submissions', page: 'Submissions', active: true },
                { name: 'Events', page: 'Events' },
                { name: 'API Docs', page: 'ApiDocs' }
              ].map(item => (
                <Link
                  key={item.page}
                  to={createPageUrl(item.page)}
                  className={`px-3 py-2 text-sm font-mono rounded transition-colors ${
                    item.active 
                      ? 'bg-slate-800 text-amber-400' 
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
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
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search submissions..."
                className="pl-9 bg-slate-900 border-slate-700 text-slate-100 w-64 font-mono text-sm"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36 bg-slate-900 border-slate-700 text-slate-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="all" className="text-slate-100">All Status</SelectItem>
                <SelectItem value="pending" className="text-slate-100">Pending</SelectItem>
                <SelectItem value="approved" className="text-slate-100">Approved</SelectItem>
                <SelectItem value="rejected" className="text-slate-100">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="text-sm font-mono text-slate-500">
            {submissions.filter(s => s.status === 'pending').length} pending review
          </div>
        </div>

        {/* Submissions Table */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900">
                <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-slate-500">Task</th>
                <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-slate-500">Worker</th>
                <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-slate-500">Type</th>
                <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-slate-500">Status</th>
                <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-slate-500">Time</th>
                <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-slate-500">Submitted</th>
                <th className="w-24"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filteredSubmissions.map(sub => (
                <tr key={sub.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="p-4">
                    <p className="text-sm font-mono text-slate-200">{sub.task_title}</p>
                  </td>
                  <td className="p-4">
                    <span className="text-sm font-mono text-slate-400">{sub.worker_name}</span>
                  </td>
                  <td className="p-4">
                    <span className="text-xs font-mono text-slate-500">{sub.output_type}</span>
                  </td>
                  <td className="p-4">
                    <StatusBadge status={sub.status} />
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-1 text-xs font-mono text-slate-500">
                      <Clock className="w-3 h-3" />
                      {sub.processing_time_ms ? `${(sub.processing_time_ms / 1000).toFixed(1)}s` : '-'}
                    </div>
                  </td>
                  <td className="p-4">
                    <span className="text-xs font-mono text-slate-500">
                      {format(new Date(sub.created_date), 'MMM d, HH:mm')}
                    </span>
                  </td>
                  <td className="p-4">
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => { setSelectedSubmission(sub); setReviewNotes(''); }}
                      className="text-slate-400 hover:text-slate-200"
                    >
                      <Eye className="w-4 h-4 mr-1" /> View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredSubmissions.length === 0 && (
            <div className="p-12 text-center text-slate-500 font-mono">
              No submissions found
            </div>
          )}
        </div>
      </main>

      {/* Submission Review Dialog */}
      <Dialog open={!!selectedSubmission} onOpenChange={() => setSelectedSubmission(null)}>
        <DialogContent className="bg-slate-900 border-slate-700 max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-slate-100 font-mono">
              Review Submission
            </DialogTitle>
          </DialogHeader>
          
          {selectedSubmission && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-slate-500 font-mono uppercase">Task</p>
                  <p className="text-sm font-mono text-slate-200 mt-1">{selectedSubmission.task_title}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 font-mono uppercase">Worker</p>
                  <p className="text-sm font-mono text-slate-200 mt-1">{selectedSubmission.worker_name}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 font-mono uppercase">Status</p>
                  <div className="mt-1"><StatusBadge status={selectedSubmission.status} /></div>
                </div>
                <div>
                  <p className="text-xs text-slate-500 font-mono uppercase">Processing Time</p>
                  <p className="text-sm font-mono text-slate-200 mt-1">
                    {selectedSubmission.processing_time_ms ? `${(selectedSubmission.processing_time_ms / 1000).toFixed(2)}s` : '-'}
                  </p>
                </div>
              </div>

              <div>
                <p className="text-xs text-slate-500 font-mono uppercase mb-2">Output ({selectedSubmission.output_type})</p>
                <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs font-mono text-slate-300 overflow-x-auto max-h-64">
                  {formatOutput(selectedSubmission.output_data)}
                </pre>
              </div>

              {selectedSubmission.status === 'pending' && (
                <>
                  <div>
                    <p className="text-xs text-slate-500 font-mono uppercase mb-2">Review Notes</p>
                    <Textarea
                      value={reviewNotes}
                      onChange={(e) => setReviewNotes(e.target.value)}
                      placeholder="Optional notes for the worker..."
                      className="bg-slate-900 border-slate-700 text-slate-100 font-mono text-sm"
                    />
                  </div>

                  <div className="flex justify-end gap-3 pt-4 border-t border-slate-800">
                    <Button 
                      variant="outline" 
                      onClick={handleReject}
                      disabled={reviewMutation.isPending}
                      className="border-red-600 text-red-400 hover:bg-red-600/10"
                    >
                      <XCircle className="w-4 h-4 mr-2" /> Reject
                    </Button>
                    <Button 
                      onClick={handleApprove}
                      disabled={reviewMutation.isPending}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white"
                    >
                      <CheckCircle className="w-4 h-4 mr-2" /> Approve
                    </Button>
                  </div>
                </>
              )}

              {selectedSubmission.status !== 'pending' && selectedSubmission.review_notes && (
                <div>
                  <p className="text-xs text-slate-500 font-mono uppercase mb-2">Review Notes</p>
                  <p className="text-sm text-slate-300 font-mono">{selectedSubmission.review_notes}</p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}