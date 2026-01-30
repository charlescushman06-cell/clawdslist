import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CheckCircle2, XCircle, FileText, Waves } from 'lucide-react';
import { format } from 'date-fns';

export default function ReviewQueue() {
  const queryClient = useQueryClient();
  const [selectedSubmission, setSelectedSubmission] = useState(null);
  const [rubricScores, setRubricScores] = useState({});
  const [feedback, setFeedback] = useState('');
  const [decision, setDecision] = useState('accept');
  const [rejectionReason, setRejectionReason] = useState('');

  const { data: submissions = [] } = useQuery({
    queryKey: ['review_queue'],
    queryFn: async () => {
      const subs = await base44.entities.Submission.filter({ validation_status: 'needs_review' });
      return subs;
    }
  });

  const { data: milestones = [] } = useQuery({
    queryKey: ['milestones'],
    queryFn: () => base44.entities.Milestone.list()
  });

  const submitReviewMutation = useMutation({
    mutationFn: async ({ submission, decision, scores, feedback, reason }) => {
      const milestone = milestones.find(m => m.id === submission.milestone_id);
      if (!milestone) throw new Error('Milestone not found');

      const rubric = milestone.rubric || [];
      const overallScore = rubric.length > 0
        ? Object.values(scores).reduce((a, b) => a + b, 0) / rubric.length
        : 0;

      const user = await base44.auth.me();
      
      await base44.entities.Review.create({
        milestone_id: submission.milestone_id,
        submission_id: submission.id,
        reviewer_id: user.id,
        reviewer_name: user.full_name || user.email,
        rubric_scores: JSON.stringify(scores),
        overall_score: overallScore,
        decision,
        feedback,
        rejection_reason: decision === 'reject' ? reason : null
      });

      const qualityScore = Math.round((overallScore / 5) * 100);

      await base44.entities.Submission.update(submission.id, {
        validation_status: decision === 'accept' ? 'accepted' : 'rejected',
        status: decision === 'accept' ? 'approved' : 'rejected',
        quality_score: qualityScore,
        rejection_reason: decision === 'reject' ? reason : null,
        review_notes: feedback
      });

      if (decision === 'accept') {
        await base44.entities.Milestone.update(submission.milestone_id, {
          status: 'accepted',
          completed_at: new Date().toISOString(),
          review_notes: feedback
        });
      }

      await base44.entities.Event.create({
        event_type: decision === 'accept' ? 'milestone_review_accepted' : 'milestone_review_rejected',
        entity_type: 'milestone',
        entity_id: submission.milestone_id,
        actor_type: 'admin',
        actor_id: user.id,
        details: JSON.stringify({ submission_id: submission.id, quality_score: qualityScore })
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['review_queue']);
      queryClient.invalidateQueries(['milestones']);
      setSelectedSubmission(null);
      setRubricScores({});
      setFeedback('');
      setDecision('accept');
      setRejectionReason('');
    }
  });

  const handleSubmitReview = () => {
    submitReviewMutation.mutate({
      submission: selectedSubmission,
      decision,
      scores: rubricScores,
      feedback,
      reason: rejectionReason
    });
  };

  const handleOpenReview = (submission) => {
    setSelectedSubmission(submission);
    const milestone = milestones.find(m => m.id === submission.milestone_id);
    if (milestone?.rubric) {
      const initialScores = {};
      milestone.rubric.forEach(dim => {
        initialScores[dim.dimension] = 3;
      });
      setRubricScores(initialScores);
    }
  };

  return (
    <div className="min-h-screen bg-black text-slate-100" style={{ fontFamily: "'Courier New', monospace" }}>
      <header className="border-b border-red-900/50 bg-slate-950/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-600/20 rounded-xl">
                <FileText className="w-6 h-6 text-red-500" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-red-500">Review Queue</h1>
                <p className="text-xs text-slate-500">Quorum Validation Portal</p>
              </div>
            </div>
            <nav className="flex items-center gap-1">
              {[
                { name: 'Dashboard', page: 'Dashboard' },
                { name: 'Tasks', page: 'Tasks' },
                { name: 'Review Queue', page: 'ReviewQueue', active: true },
                { name: 'API Docs', page: 'ApiDocs' }
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
        <div className="bg-slate-950 border border-red-900/50 rounded-lg">
          <div className="p-4 border-b border-red-900/30">
            <h2 className="text-sm uppercase tracking-wider text-slate-400">
              Submissions Awaiting Review ({submissions.length})
            </h2>
          </div>

          <div className="divide-y divide-red-900/30">
            {submissions.map(sub => {
              const milestone = milestones.find(m => m.id === sub.milestone_id);
              return (
                <div key={sub.id} className="p-4 hover:bg-slate-900/30 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <p className="text-sm text-slate-200 font-medium">{sub.task_title}</p>
                      <p className="text-xs text-slate-500 mt-1">
                        Milestone: {milestone?.title || 'Unknown'}
                      </p>
                      <p className="text-xs text-slate-600 mt-1">
                        Worker: {sub.worker_name} • {format(new Date(sub.created_date), 'MMM d, HH:mm')}
                      </p>
                    </div>
                    <Button
                      onClick={() => handleOpenReview(sub)}
                      className="bg-red-600/20 text-red-400 hover:bg-red-600/30"
                    >
                      Review
                    </Button>
                  </div>
                </div>
              );
            })}
            {submissions.length === 0 && (
              <div className="p-12 text-center text-slate-500 text-sm">
                No submissions in review queue
              </div>
            )}
          </div>
        </div>
      </main>

      {selectedSubmission && (
        <Dialog open={!!selectedSubmission} onOpenChange={() => setSelectedSubmission(null)}>
          <DialogContent className="bg-slate-900 border-red-900/50 max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-slate-100">Review Submission</DialogTitle>
            </DialogHeader>

            <div className="space-y-6">
              {/* Milestone Info */}
              <div className="bg-slate-950 border border-red-900/30 rounded-lg p-4">
                <h3 className="text-sm text-red-400 font-medium mb-2">Milestone Instructions</h3>
                <p className="text-sm text-slate-300">
                  {milestones.find(m => m.id === selectedSubmission.milestone_id)?.description}
                </p>
              </div>

              {/* Submission Output */}
              <div className="bg-slate-950 border border-red-900/30 rounded-lg p-4">
                <h3 className="text-sm text-red-400 font-medium mb-2">Submitted Work</h3>
                <pre className="text-xs text-slate-300 whitespace-pre-wrap bg-black/50 p-3 rounded">
                  {typeof selectedSubmission.output_data === 'string' 
                    ? selectedSubmission.output_data 
                    : JSON.stringify(selectedSubmission.output_data, null, 2)}
                </pre>
              </div>

              {/* Rubric Scoring */}
              {milestones.find(m => m.id === selectedSubmission.milestone_id)?.rubric && (
                <div className="bg-slate-950 border border-red-900/30 rounded-lg p-4">
                  <h3 className="text-sm text-red-400 font-medium mb-3">Rubric (0-5 scale)</h3>
                  <div className="space-y-3">
                    {milestones.find(m => m.id === selectedSubmission.milestone_id).rubric.map((dim, idx) => (
                      <div key={idx}>
                        <label className="text-xs text-slate-400 block mb-1">{dim.dimension}</label>
                        <Select
                          value={String(rubricScores[dim.dimension] || 3)}
                          onValueChange={(val) => setRubricScores({ ...rubricScores, [dim.dimension]: parseInt(val) })}
                        >
                          <SelectTrigger className="bg-slate-800 border-red-900/30 text-slate-200">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-slate-800 border-red-900/30">
                            {[0, 1, 2, 3, 4, 5].map(score => (
                              <SelectItem key={score} value={String(score)} className="text-slate-200">
                                {score} - {dim.labels?.[score] || ''}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Decision */}
              <div className="bg-slate-950 border border-red-900/30 rounded-lg p-4">
                <h3 className="text-sm text-red-400 font-medium mb-3">Decision</h3>
                <Select value={decision} onValueChange={setDecision}>
                  <SelectTrigger className="bg-slate-800 border-red-900/30 text-slate-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-red-900/30">
                    <SelectItem value="accept" className="text-green-400">Accept</SelectItem>
                    <SelectItem value="reject" className="text-red-400">Reject</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {decision === 'reject' && (
                <div className="bg-slate-950 border border-red-900/30 rounded-lg p-4">
                  <label className="text-xs text-red-400 font-medium block mb-2">Rejection Reason</label>
                  <Select value={rejectionReason} onValueChange={setRejectionReason}>
                    <SelectTrigger className="bg-slate-800 border-red-900/30 text-slate-200">
                      <SelectValue placeholder="Select reason..." />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-red-900/30">
                      <SelectItem value="incomplete">Incomplete Work</SelectItem>
                      <SelectItem value="quality">Below Quality Standards</SelectItem>
                      <SelectItem value="off_spec">Off-Specification</SelectItem>
                      <SelectItem value="plagiarism">Plagiarism Detected</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Feedback */}
              <div>
                <label className="text-xs text-slate-400 block mb-2">Feedback</label>
                <Textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Provide detailed feedback..."
                  className="bg-slate-950 border-red-900/30 text-slate-200 min-h-24"
                />
              </div>

              {/* Actions */}
              <div className="flex gap-3">
                <Button
                  onClick={handleSubmitReview}
                  disabled={decision === 'reject' && !rejectionReason}
                  className={decision === 'accept' 
                    ? 'bg-green-600 hover:bg-green-500 flex-1' 
                    : 'bg-red-600 hover:bg-red-500 flex-1'
                  }
                >
                  {decision === 'accept' ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 mr-2" /> Accept Submission
                    </>
                  ) : (
                    <>
                      <XCircle className="w-4 h-4 mr-2" /> Reject Submission
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setSelectedSubmission(null)}
                  className="border-red-900/30 text-slate-400"
                >
                  Cancel
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}