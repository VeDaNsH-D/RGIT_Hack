/**
 * @file contextBuilder.test.js
 * @description Unit tests for contextBuilder mapping and database extraction logic using node:test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapToContextPackRequest,
  buildProjectContextPack,
} from '../../src/services/contextBuilder.js';

describe('contextBuilder: mapToContextPackRequest', () => {
  const mockProject = {
    _id: '507f1f77bcf86cd799439011',
    name: 'Relay Core Platform',
    description: 'Autonomous handoff and context synthesis system',
  };

  const mockTasks = [
    {
      _id: 'task_001',
      title: 'Fix Redis connection leak',
      description: 'Connection pool exhausted under high traffic',
      status: 'open',
      priority: 'critical',
      assignee: 'usr_alice',
      deadline: new Date('2026-10-15T12:00:00Z'),
      origin: 'manual',
      sourceRecordId: 'src_rec_001',
      createdAt: new Date('2026-10-11T10:00:00Z'),
    },
    {
      _id: 'task_002',
      title: 'Update API docs',
      description: '',
      status: 'completed',
      priority: 'low',
      assignee: null,
      deadline: null, // Unknown deadline: must remain null
      origin: 'manual',
    },
  ];

  const mockDocuments = [
    {
      _id: 'doc_001',
      title: 'Architecture Blueprint',
      filename: 'blueprint.pdf',
      mimeType: 'application/pdf',
      size: 512000,
      url: 'https://storage.relay.internal/blueprint.pdf',
      extractedText: 'All services must enforce mutual TLS authentication.',
      uploadedBy: 'usr_alice',
      createdAt: new Date('2026-10-10T08:00:00Z'),
    },
    {
      _id: 'doc_002',
      title: 'Empty Spec Doc',
      filename: 'empty.pdf',
      mimeType: 'application/pdf',
      size: 0,
      extractedText: '   ', // Whitespace: must be normalized to null without fabricating
    },
  ];

  const mockSourceRecords = [
    {
      _id: 'src_rec_001',
      externalId: 'gh_issue_42',
      provider: 'github',
      type: 'issue',
      title: 'Redis connection pool exhaustion',
      content: 'Pool exhausted after 1000 concurrent requests.',
      contentType: 'text/markdown',
      url: 'https://github.com/relay/core/issues/42',
      metadata: { author: 'dev_carol', authorId: 'gh_101', fetchedAt: new Date('2026-10-12T00:00:00Z') },
      createdAt: new Date('2026-10-11T09:00:00Z'),
    },
    {
      _id: 'src_dec_001',
      provider: 'manual',
      type: 'decision',
      title: 'Increase Redis maxConnections to 500',
      content: 'Decided in incident retrospective to bump pool size.',
      metadata: { author: 'lead_bob' },
      createdAt: new Date('2026-10-11T14:00:00Z'),
    },
    {
      _id: 'src_note_001',
      provider: 'manual',
      type: 'note',
      title: 'Follow-up with infra team',
      content: '', // Empty note content: must remain empty string without inventing
      createdAt: new Date('2026-10-11T15:00:00Z'),
    },
  ];

  it('maps complete project data to ContextPackRequest and preserves database IDs', () => {
    const result = mapToContextPackRequest({
      project: mockProject,
      tasks: mockTasks,
      documents: mockDocuments,
      sourceRecords: mockSourceRecords,
    });

    // 1. Case details
    assert.equal(result.case_id, '507f1f77bcf86cd799439011');
    assert.equal(result.case_description, mockProject.description);

    // 2. Tasks mapping
    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[0].id, 'task_001');
    assert.equal(result.tasks[0].title, 'Fix Redis connection leak');
    assert.equal(result.tasks[0].priority, 'critical');
    assert.equal(result.tasks[0].deadline, '2026-10-15T12:00:00.000Z');
    assert.equal(result.tasks[0].source_record_id, 'src_rec_001');

    // Deadlines never invented
    assert.equal(result.tasks[1].id, 'task_002');
    assert.equal(result.tasks[1].deadline, null);

    // 3. Documents mapping
    assert.equal(result.documents.length, 2);
    assert.equal(result.documents[0].id, 'doc_001');
    assert.equal(result.documents[0].extracted_text, 'All services must enforce mutual TLS authentication.');
    // Missing/whitespace text remains null
    assert.equal(result.documents[1].id, 'doc_002');
    assert.equal(result.documents[1].extracted_text, null);

    // 4. Source records mapping (including manual decisions and notes)
    assert.equal(result.sources.length, 3);
    assert.equal(result.sources[0].id, 'src_rec_001');
    assert.equal(result.sources[0].record_type, 'issue');
    assert.equal(result.sources[0].author, 'dev_carol');
    assert.equal(result.sources[0].content, 'Pool exhausted after 1000 concurrent requests.');

    assert.equal(result.sources[1].id, 'src_dec_001');
    assert.equal(result.sources[1].record_type, 'decision');
    assert.equal(result.sources[1].content, 'Decided in incident retrospective to bump pool size.');

    assert.equal(result.sources[2].id, 'src_note_001');
    assert.equal(result.sources[2].record_type, 'note');
    assert.equal(result.sources[2].content, '');
  });

  it('throws an error if project is missing', () => {
    assert.throws(
      () => mapToContextPackRequest({ project: null }),
      /Project object is required/
    );
  });
});

describe('contextBuilder: buildProjectContextPack', () => {
  it('invokes .select("+extractedText") on Document and builds pack successfully', async () => {
    let selectArg = null;
    let documentQueried = false;

    const mockProject = {
      _id: '507f1f77bcf86cd799439099',
      description: 'Async test',
    };

    const mockTaskModel = {
      find: (filter) => ({
        lean: async () => [{ _id: 't_1', title: 'Task 1' }],
      }),
    };

    const mockDocumentModel = {
      find: (filter) => {
        documentQueried = true;
        return {
          select: (fields) => {
            selectArg = fields;
            return {
              lean: async () => [{ _id: 'd_1', title: 'Doc 1', extractedText: 'Content' }],
            };
          },
        };
      },
    };

    const mockSourceRecordModel = {
      find: (filter) => ({
        lean: async () => [{ _id: 's_1', title: 'Source 1', content: 'Issue content' }],
      }),
    };

    const result = await buildProjectContextPack('507f1f77bcf86cd799439099', {
      project: mockProject,
      taskModel: mockTaskModel,
      documentModel: mockDocumentModel,
      sourceRecordModel: mockSourceRecordModel,
    });

    assert.ok(documentQueried);
    assert.equal(selectArg, '+extractedText');
    assert.equal(result.case_id, '507f1f77bcf86cd799439099');
    assert.equal(result.tasks.length, 1);
    assert.equal(result.documents.length, 1);
    assert.equal(result.sources.length, 1);
  });

  it('throws 404 when project does not exist', async () => {
    const mockProjectModel = {
      findById: () => ({
        lean: async () => null,
      }),
    };

    await assert.rejects(
      async () => buildProjectContextPack('non_existent_id', { projectModel: mockProjectModel }),
      (err) => {
        assert.equal(err.status, 404);
        assert.equal(err.code, 'not_found');
        return true;
      }
    );
  });
});
