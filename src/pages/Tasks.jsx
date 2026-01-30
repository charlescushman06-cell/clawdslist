import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import StatusBadge from '@/components/admin/StatusBadge';
import TaskForm from '@/components/admin/TaskForm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { 
  Plus, 
  Search, 
  Filter,
  Waves,
  MoreVertical,
  Pencil,
  Trash2,
  RefreshCw,
  Clock,
  XCircle
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { format } from 'date-fns';

const TASK_TYPES = [
  { value: 'all', label: 'All Types' },
  { value: 'data_extraction', label: 'Data Extraction' },
  { value: 'content_generation', label: 'Content Generation' },
  { value: 'code_review', label: 'Code Review' },
  { value: 'classification', label: 'Classification' },
  { value: 'transformation', label: 'Transformation' },
  { value: 'verification', label: 'Verification' },
  { value: 'other', label: 'Other' }
];

const STATUS_OPTIONS = [
  { value: 'all', label: 'All Status' },
  { value: 'open', label: 'Open' },
  { value: 'claimed', label: 'Claimed' },
  { value: 'completed', label: 'Completed' },
  { value: 'expired', label: 'Expired' },
  { value: 'disputed', label: 'Disputed' },
  { value: 'cancelled', label: 'Cancelled' }
];

export default function Tasks() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => base44.entities.Task.list('-created_date', 200)
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.Task.create({ ...data, status: 'open' }),
    onSuccess: () => {
      queryClient.invalidateQueries(['tasks']);
      setShowForm(false);
      // Log event
      base44.entities.Event.create({
        event_type: 'task_created',
        entity_type: 'task',
        actor_type: 'admin',
        actor_id: 'admin'
      });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Task.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries(['tasks']);
      setShowForm(false);
      setEditingTask(null);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Task.delete(id),
    onSuccess: () => queryClient.invalidateQueries(['tasks'])
  });

  const filteredTasks = tasks.filter(task => {
    const matchesSearch = !search || 
      task.title?.toLowerCase().includes(search.toLowerCase()) ||
      task.description?.toLowerCase().includes(search.toLowerCase());
    const matchesType = typeFilter === 'all' || task.type === typeFilter;
    const matchesStatus = statusFilter === 'all' || task.status === statusFilter;
    return matchesSearch && matchesType && matchesStatus;
  });

  const handleSubmit = (data) => {
    if (editingTask) {
      updateMutation.mutate({ id: editingTask.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const handleEdit = (task) => {
    setEditingTask(task);
    setShowForm(true);
  };

  const handleCancel = (task) => {
    updateMutation.mutate({ id: task.id, data: { status: 'cancelled' } });
  };

  const handleReopen = (task) => {
    updateMutation.mutate({ 
      id: task.id, 
      data: { 
        status: 'open', 
        claimed_by: null, 
        claimed_at: null,
        completed_at: null 
      } 
    });
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
                <h1 className="text-xl font-mono font-bold text-slate-100">Tasks</h1>
                <p className="text-xs text-slate-500 font-mono">Task Pool Management</p>
              </div>
            </div>
            <nav className="flex items-center gap-1">
              {[
                { name: 'Dashboard', page: 'Dashboard' },
                { name: 'Tasks', page: 'Tasks', active: true },
                { name: 'Workers', page: 'Workers' },
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
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tasks..."
                className="pl-9 bg-slate-900 border-slate-700 text-slate-100 w-64 font-mono text-sm"
              />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-40 bg-slate-900 border-slate-700 text-slate-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                {TASK_TYPES.map(t => (
                  <SelectItem key={t.value} value={t.value} className="text-slate-100">{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36 bg-slate-900 border-slate-700 text-slate-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                {STATUS_OPTIONS.map(s => (
                  <SelectItem key={s.value} value={s.value} className="text-slate-100">{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => { setEditingTask(null); setShowForm(true); }} className="bg-amber-600 hover:bg-amber-500 text-slate-900 font-mono">
            <Plus className="w-4 h-4 mr-2" /> Create Task
          </Button>
        </div>

        {/* Task Table */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900">
                <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-slate-500">Title</th>
                <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-slate-500">Type</th>
                <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-slate-500">Status</th>
                <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-slate-500">Priority</th>
                <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-slate-500">Reward</th>
                <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-slate-500">Created</th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filteredTasks.map(task => (
                <tr key={task.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="p-4">
                    <div>
                      <p className="text-sm font-mono text-slate-200">{task.title}</p>
                      <p className="text-xs text-slate-500 truncate max-w-xs">{task.description}</p>
                    </div>
                  </td>
                  <td className="p-4">
                    <span className="text-xs font-mono text-slate-400">{task.type}</span>
                  </td>
                  <td className="p-4">
                    <StatusBadge status={task.status} />
                  </td>
                  <td className="p-4">
                    <span className="text-sm font-mono text-slate-300">{task.priority || 0}</span>
                  </td>
                  <td className="p-4">
                    <span className="text-sm font-mono text-amber-400">{task.reward_credits || 0}</span>
                  </td>
                  <td className="p-4">
                    <span className="text-xs font-mono text-slate-500">
                      {format(new Date(task.created_date), 'MMM d, HH:mm')}
                    </span>
                  </td>
                  <td className="p-4">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400">
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bg-slate-800 border-slate-700">
                        <DropdownMenuItem onClick={() => handleEdit(task)} className="text-slate-200">
                          <Pencil className="w-4 h-4 mr-2" /> Edit
                        </DropdownMenuItem>
                        {(task.status === 'claimed' || task.status === 'completed' || task.status === 'expired') && (
                          <DropdownMenuItem onClick={() => handleReopen(task)} className="text-slate-200">
                            <RefreshCw className="w-4 h-4 mr-2" /> Reopen
                          </DropdownMenuItem>
                        )}
                        {task.status === 'open' && (
                          <DropdownMenuItem onClick={() => handleCancel(task)} className="text-yellow-400">
                            <XCircle className="w-4 h-4 mr-2" /> Cancel
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => deleteMutation.mutate(task.id)} className="text-red-400">
                          <Trash2 className="w-4 h-4 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredTasks.length === 0 && (
            <div className="p-12 text-center text-slate-500 font-mono">
              No tasks found
            </div>
          )}
        </div>
      </main>

      {/* Task Form Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-slate-900 border-slate-700 max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-slate-100 font-mono">
              {editingTask ? 'Edit Task' : 'Create New Task'}
            </DialogTitle>
          </DialogHeader>
          <TaskForm
            task={editingTask}
            onSubmit={handleSubmit}
            onCancel={() => { setShowForm(false); setEditingTask(null); }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}