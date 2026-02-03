import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { 
  ArrowLeft, Plus, Pencil, Power, PowerOff, Search, Filter,
  BookOpen, FileText, Hash, AlertTriangle
} from 'lucide-react';
import { toast } from 'sonner';

const SOURCES = ['nature', 'ieee', 'jstor', 'elsevier', 'acm', 'arxiv', 'springer', 'wiley'];
const DERIVATION_METHODS = [
  { value: 'page2_sha256_prefix16', label: 'Page 2 SHA256 Prefix (16 chars)' },
  { value: 'abstract_sha256_prefix16', label: 'Abstract SHA256 Prefix (16 chars)' },
  { value: 'custom', label: 'Custom Method' }
];

export default function JournalCorpus() {
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [activeFilter, setActiveFilter] = useState('all');
  const [editItem, setEditItem] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const queryClient = useQueryClient();

  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me()
  });

  const { data: corpusItems = [], isLoading } = useQuery({
    queryKey: ['journalCorpus'],
    queryFn: () => base44.entities.JournalChallengeCorpus.list('-created_date', 200)
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.JournalChallengeCorpus.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['journalCorpus'] });
      toast.success('Corpus item created');
      setShowForm(false);
      setEditItem(null);
    },
    onError: (err) => toast.error(err.message)
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.JournalChallengeCorpus.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['journalCorpus'] });
      toast.success('Corpus item updated');
      setShowForm(false);
      setEditItem(null);
    },
    onError: (err) => toast.error(err.message)
  });

  const rotateMutation = useMutation({
    mutationFn: (corpusId) => base44.functions.invoke('api', { 
      action: 'admin_rotate_corpus_item', 
      corpus_id: corpusId 
    }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['journalCorpus'] });
      const data = res.data?.data || res.data;
      toast.success(`Deactivated. ${data?.challenges_expired || 0} challenges expired.`);
    },
    onError: (err) => toast.error(err.message)
  });

  if (user?.role !== 'admin') {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl text-white mb-2">Access Denied</h2>
          <p className="text-slate-400">Admin privileges required</p>
        </div>
      </div>
    );
  }

  const filteredItems = corpusItems.filter(item => {
    const matchesSearch = !search || 
      item.title?.toLowerCase().includes(search.toLowerCase()) ||
      item.doi?.toLowerCase().includes(search.toLowerCase());
    const matchesSource = sourceFilter === 'all' || item.source === sourceFilter;
    const matchesActive = activeFilter === 'all' || 
      (activeFilter === 'active' && item.active !== false) ||
      (activeFilter === 'inactive' && item.active === false);
    return matchesSearch && matchesSource && matchesActive;
  });

  const handleSubmit = (formData) => {
    if (editItem) {
      updateMutation.mutate({ id: editItem.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const openCreate = () => {
    setEditItem(null);
    setShowForm(true);
  };

  const openEdit = (item) => {
    setEditItem(item);
    setShowForm(true);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to={createPageUrl('Dashboard')}>
              <Button variant="ghost" size="sm" className="text-slate-400 hover:text-white">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Dashboard
              </Button>
            </Link>
            <div className="h-4 w-px bg-slate-700" />
            <div className="flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-amber-500" />
              <h1 className="text-lg font-semibold">Journal Challenge Corpus</h1>
            </div>
          </div>
          <Button onClick={openCreate} className="bg-amber-600 hover:bg-amber-700">
            <Plus className="w-4 h-4 mr-2" />
            Add Corpus Item
          </Button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title or DOI..."
              className="pl-9 bg-slate-900 border-slate-700"
            />
          </div>
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-36 bg-slate-900 border-slate-700">
              <Filter className="w-4 h-4 mr-2" />
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              <SelectItem value="all">All Sources</SelectItem>
              {SOURCES.map(s => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={activeFilter} onValueChange={setActiveFilter}>
            <SelectTrigger className="w-36 bg-slate-900 border-slate-700">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-sm text-slate-500 ml-auto">
            {filteredItems.length} items
          </span>
        </div>

        {/* Table */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="text-slate-400">Title</TableHead>
                <TableHead className="text-slate-400">Source</TableHead>
                <TableHead className="text-slate-400">DOI</TableHead>
                <TableHead className="text-slate-400">Verification</TableHead>
                <TableHead className="text-slate-400">Status</TableHead>
                <TableHead className="text-slate-400 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-slate-500">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : filteredItems.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-slate-500">
                    No corpus items found
                  </TableCell>
                </TableRow>
              ) : (
                filteredItems.map(item => (
                  <TableRow key={item.id} className="border-slate-800">
                    <TableCell className="font-medium max-w-xs truncate">
                      {item.title}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-amber-400 border-amber-400/30">
                        {item.source}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-slate-400 text-sm font-mono max-w-[150px] truncate">
                      {item.doi || '-'}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {item.expected_sha256_pdf && (
                          <Badge className="bg-blue-500/20 text-blue-400 text-xs">PDF</Badge>
                        )}
                        {item.derived_string_hash && (
                          <Badge className="bg-purple-500/20 text-purple-400 text-xs">Derived</Badge>
                        )}
                        {!item.expected_sha256_pdf && !item.derived_string_hash && (
                          <Badge className="bg-red-500/20 text-red-400 text-xs">No Hash</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {item.active !== false ? (
                        <Badge className="bg-green-500/20 text-green-400">Active</Badge>
                      ) : (
                        <Badge className="bg-slate-500/20 text-slate-400">Inactive</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => openEdit(item)}
                          className="text-slate-400 hover:text-white"
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        {item.active !== false && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => rotateMutation.mutate(item.id)}
                            disabled={rotateMutation.isPending}
                            className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                          >
                            <PowerOff className="w-4 h-4" />
                          </Button>
                        )}
                        {item.active === false && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => updateMutation.mutate({ id: item.id, data: { active: true } })}
                            className="text-green-400 hover:text-green-300 hover:bg-green-500/10"
                          >
                            <Power className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </main>

      {/* Create/Edit Dialog */}
      <CorpusFormDialog
        open={showForm}
        onClose={() => { setShowForm(false); setEditItem(null); }}
        onSubmit={handleSubmit}
        initialData={editItem}
        isLoading={createMutation.isPending || updateMutation.isPending}
      />
    </div>
  );
}

function CorpusFormDialog({ open, onClose, onSubmit, initialData, isLoading }) {
  const [formData, setFormData] = useState({
    source: '',
    title: '',
    doi: '',
    expected_sha256_pdf: '',
    derived_string_hash: '',
    derivation_method: 'page2_sha256_prefix16',
    derivation_instructions: '',
    notes: '',
    active: true
  });

  React.useEffect(() => {
    if (initialData) {
      setFormData({
        source: initialData.source || '',
        title: initialData.title || '',
        doi: initialData.doi || '',
        expected_sha256_pdf: initialData.expected_sha256_pdf || '',
        derived_string_hash: initialData.derived_string_hash || '',
        derivation_method: initialData.derivation_method || 'page2_sha256_prefix16',
        derivation_instructions: initialData.derivation_instructions || '',
        notes: initialData.notes || '',
        active: initialData.active !== false
      });
    } else {
      setFormData({
        source: '',
        title: '',
        doi: '',
        expected_sha256_pdf: '',
        derived_string_hash: '',
        derivation_method: 'page2_sha256_prefix16',
        derivation_instructions: '',
        notes: '',
        active: true
      });
    }
  }, [initialData, open]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!formData.source || !formData.title) {
      toast.error('Source and title are required');
      return;
    }
    onSubmit(formData);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="bg-slate-900 border-slate-700 text-white max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-amber-500" />
            {initialData ? 'Edit Corpus Item' : 'Add Corpus Item'}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Source *</Label>
              <Select value={formData.source} onValueChange={(v) => setFormData({ ...formData, source: v })}>
                <SelectTrigger className="bg-slate-800 border-slate-700">
                  <SelectValue placeholder="Select source" />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  {SOURCES.map(s => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>DOI</Label>
              <Input
                value={formData.doi}
                onChange={(e) => setFormData({ ...formData, doi: e.target.value })}
                placeholder="10.1234/example"
                className="bg-slate-800 border-slate-700 font-mono text-sm"
              />
            </div>
          </div>

          <div>
            <Label>Title *</Label>
            <Input
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              placeholder="Article title"
              className="bg-slate-800 border-slate-700"
            />
          </div>

          <div className="border-t border-slate-700 pt-4">
            <h4 className="text-sm font-medium text-slate-300 mb-3 flex items-center gap-2">
              <Hash className="w-4 h-4" />
              Verification Hashes
            </h4>
            <div className="space-y-3">
              <div>
                <Label className="text-slate-400">PDF SHA256 (64 hex chars)</Label>
                <Input
                  value={formData.expected_sha256_pdf}
                  onChange={(e) => setFormData({ ...formData, expected_sha256_pdf: e.target.value })}
                  placeholder="a1b2c3d4..."
                  className="bg-slate-800 border-slate-700 font-mono text-xs"
                />
              </div>
              <div>
                <Label className="text-slate-400">Derived String Hash (16 hex chars)</Label>
                <Input
                  value={formData.derived_string_hash}
                  onChange={(e) => setFormData({ ...formData, derived_string_hash: e.target.value })}
                  placeholder="a1b2c3d4e5f67890"
                  className="bg-slate-800 border-slate-700 font-mono text-xs"
                />
              </div>
              <div>
                <Label className="text-slate-400">Derivation Method</Label>
                <Select 
                  value={formData.derivation_method} 
                  onValueChange={(v) => setFormData({ ...formData, derivation_method: v })}
                >
                  <SelectTrigger className="bg-slate-800 border-slate-700">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    {DERIVATION_METHODS.map(m => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-slate-400">Derivation Instructions (optional)</Label>
                <Textarea
                  value={formData.derivation_instructions}
                  onChange={(e) => setFormData({ ...formData, derivation_instructions: e.target.value })}
                  placeholder="Custom instructions for computing the derived string..."
                  className="bg-slate-800 border-slate-700 text-sm h-20"
                />
              </div>
            </div>
          </div>

          <div>
            <Label className="text-slate-400">Admin Notes</Label>
            <Textarea
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              placeholder="Internal notes..."
              className="bg-slate-800 border-slate-700 text-sm h-16"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} className="border-slate-600">
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading} className="bg-amber-600 hover:bg-amber-700">
              {isLoading ? 'Saving...' : (initialData ? 'Update' : 'Create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}