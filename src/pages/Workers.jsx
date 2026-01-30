import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import StatusBadge from '@/components/admin/StatusBadge';
import WorkerForm from '@/components/admin/WorkerForm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { 
  Plus, 
  Search,
  Waves,
  MoreVertical,
  Pencil,
  Trash2,
  Key,
  Copy,
  Pause,
  Play
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { format } from 'date-fns';
import { toast } from 'sonner';

export default function Workers() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingWorker, setEditingWorker] = useState(null);
  const [search, setSearch] = useState('');

  const { data: workers = [], isLoading } = useQuery({
    queryKey: ['workers'],
    queryFn: () => base44.entities.Worker.list('-created_date')
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.Worker.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries(['workers']);
      setShowForm(false);
      base44.entities.Event.create({
        event_type: 'worker_created',
        entity_type: 'worker',
        actor_type: 'admin',
        actor_id: 'admin'
      });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Worker.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries(['workers']);
      setShowForm(false);
      setEditingWorker(null);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Worker.delete(id),
    onSuccess: () => queryClient.invalidateQueries(['workers'])
  });

  const filteredWorkers = workers.filter(worker => {
    return !search || 
      worker.name?.toLowerCase().includes(search.toLowerCase()) ||
      worker.description?.toLowerCase().includes(search.toLowerCase());
  });

  const handleSubmit = (data) => {
    if (editingWorker) {
      updateMutation.mutate({ id: editingWorker.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const handleEdit = (worker) => {
    setEditingWorker(worker);
    setShowForm(true);
  };

  const toggleStatus = (worker) => {
    const newStatus = worker.status === 'active' ? 'suspended' : 'active';
    updateMutation.mutate({ id: worker.id, data: { status: newStatus } });
    base44.entities.Event.create({
      event_type: newStatus === 'active' ? 'worker_activated' : 'worker_suspended',
      entity_type: 'worker',
      entity_id: worker.id,
      actor_type: 'admin',
      actor_id: 'admin'
    });
  };

  const copyApiKey = (key) => {
    navigator.clipboard.writeText(key);
    toast.success('API key copied to clipboard');
  };

  const getReputationColor = (score) => {
    if (score >= 80) return 'text-emerald-400';
    if (score >= 50) return 'text-amber-400';
    return 'text-red-400';
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
                <h1 className="text-xl font-mono font-bold text-slate-100">Workers</h1>
                <p className="text-xs text-slate-500 font-mono">Agent Registry</p>
              </div>
            </div>
            <nav className="flex items-center gap-1">
              {[
                { name: 'Dashboard', page: 'Dashboard' },
                { name: 'Tasks', page: 'Tasks' },
                { name: 'Workers', page: 'Workers', active: true },
                { name: 'Submissions', page: 'Submissions' },
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
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search workers..."
              className="pl-9 bg-slate-900 border-slate-700 text-slate-100 w-64 font-mono text-sm"
            />
          </div>
          <Button onClick={() => { setEditingWorker(null); setShowForm(true); }} className="bg-amber-600 hover:bg-amber-500 text-slate-900 font-mono">
            <Plus className="w-4 h-4 mr-2" /> Register Worker
          </Button>
        </div>

        {/* Workers Grid */}
        <div className="grid grid-cols-2 gap-4">
          {filteredWorkers.map(worker => (
            <div key={worker.id} className="bg-slate-900/50 border border-slate-800 rounded-lg p-5 hover:border-slate-700 transition-colors">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-mono text-lg text-slate-100">{worker.name}</h3>
                    <StatusBadge status={worker.status} />
                  </div>
                  <p className="text-xs text-slate-500 font-mono mt-1">{worker.description || 'No description'}</p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400">
                      <MoreVertical className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="bg-slate-800 border-slate-700">
                    <DropdownMenuItem onClick={() => handleEdit(worker)} className="text-slate-200">
                      <Pencil className="w-4 h-4 mr-2" /> Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => copyApiKey(worker.api_key)} className="text-slate-200">
                      <Copy className="w-4 h-4 mr-2" /> Copy API Key
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => toggleStatus(worker)} className="text-slate-200">
                      {worker.status === 'active' ? (
                        <><Pause className="w-4 h-4 mr-2" /> Suspend</>
                      ) : (
                        <><Play className="w-4 h-4 mr-2" /> Activate</>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => deleteMutation.mutate(worker.id)} className="text-red-400">
                      <Trash2 className="w-4 h-4 mr-2" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="flex items-center gap-2 mb-4 p-2 bg-slate-800/50 rounded border border-slate-700">
                <Key className="w-4 h-4 text-slate-500" />
                <code className="text-xs text-amber-400 flex-1 truncate">{worker.api_key}</code>
                <button onClick={() => copyApiKey(worker.api_key)} className="text-slate-400 hover:text-slate-200">
                  <Copy className="w-3 h-3" />
                </button>
              </div>

              <div className="grid grid-cols-4 gap-3 text-center">
                <div>
                  <p className="text-xs text-slate-500 font-mono">Reputation</p>
                  <p className={`text-lg font-mono ${getReputationColor(worker.reputation_score || 100)}`}>
                    {worker.reputation_score || 100}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 font-mono">Completed</p>
                  <p className="text-lg font-mono text-emerald-400">{worker.tasks_completed || 0}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 font-mono">Rejected</p>
                  <p className="text-lg font-mono text-red-400">{worker.tasks_rejected || 0}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 font-mono">Expired</p>
                  <p className="text-lg font-mono text-slate-400">{worker.tasks_expired || 0}</p>
                </div>
              </div>

              {worker.capabilities?.length > 0 && (
                <div className="mt-4 pt-4 border-t border-slate-800">
                  <p className="text-xs text-slate-500 font-mono mb-2">Capabilities</p>
                  <div className="flex flex-wrap gap-1">
                    {worker.capabilities.map(cap => (
                      <span key={cap} className="px-2 py-0.5 bg-slate-800 text-slate-400 text-xs font-mono rounded">
                        {cap}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {worker.last_active_at && (
                <p className="text-xs text-slate-600 font-mono mt-4">
                  Last active: {format(new Date(worker.last_active_at), 'MMM d, HH:mm')}
                </p>
              )}
            </div>
          ))}
        </div>

        {filteredWorkers.length === 0 && (
          <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-12 text-center text-slate-500 font-mono">
            No workers registered
          </div>
        )}
      </main>

      {/* Worker Form Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-slate-900 border-slate-700 max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-slate-100 font-mono">
              {editingWorker ? 'Edit Worker' : 'Register New Worker'}
            </DialogTitle>
          </DialogHeader>
          <WorkerForm
            worker={editingWorker}
            onSubmit={handleSubmit}
            onCancel={() => { setShowForm(false); setEditingWorker(null); }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}