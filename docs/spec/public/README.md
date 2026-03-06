# Public Agent Substrate Specs

These documents are the public protocol surface for Nooterra agent collaboration.

They are written for runtime integrators (OpenClaw, Nooterra, Claude Desktop, Cursor, custom hosts) and for service providers implementing compatible control planes.

## Documents

- `AgentCard.v1.md`
- `AgentCardStreamEvent.v1.md`
- `AgentLocator.v1.md`
- `Session.v1.md`
- `SessionEvent.v1.md`
- `SessionEventProvenance.v1.md`
- `SessionPromptRiskSignals.v1.md`
- `SessionReplayPack.v1.md`
- `SessionTranscript.v1.md`
- `ToolDescriptor.v1.md`
- `AuthorityGrant.v1.md`
- `DelegationGrant.v1.md`
- `TaskQuote.v1.md`
- `TaskOffer.v1.md`
- `TaskAcceptance.v1.md`
- `SubAgentWorkOrder.v1.md`
- `SubAgentCompletionReceipt.v1.md`
- `ExecutionAttestation.v1.md`
- `Meter.v1.md`
- `ArtifactRef.v1.md`
- `AuditPacket.v1.md`
- `StateCheckpoint.v1.md`
- `Project.v1.md`
- `CapabilityAttestation.v1.md`
- `ReputationEvent.v1.md`
- `RelationshipEdge.v1.md`
- `PublicAgentReputationSummary.v1.md`
- `AuditLineage.v1.md`
- `VerifiedInteractionGraphPack.v1.md`
- `NooterraVerified.v1.md`

## Normative source of truth

The implementation is authoritative:

- `src/core`
- `src/api/app.js`
- `src/api/openapi.js`

If a doc and runtime diverge, runtime behavior is authoritative until docs are updated.

## Compatibility

Breaking changes require a new schema version.

Existing versions are immutable once published.
