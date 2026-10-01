// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title  DataProvenanceRegistry
/// @notice 데이터 수집·전처리·AI 가공 이력을 온체인에 기록하고 콘텐츠 해시로 진위를 검증한다.
/// @dev    원본 데이터는 저장하지 않는다. SHA-256 콘텐츠 해시와 메타데이터 URI만 기록한다.
contract DataProvenanceRegistry is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant AUDITOR_ROLE   = keccak256("AUDITOR_ROLE");

    enum Stage { COLLECT, PREPROCESS, AI_PROCESS, QA, LICENSE }

    struct Record {
        bytes32 contentHash;   // 해당 단계 산출물의 SHA-256
        bytes32 parentHash;    // 직전 단계 contentHash (최초 단계는 0x0)
        Stage   stage;
        address registrar;
        uint64  timestamp;
        uint64  blockNumber;
        string  metaURI;       // 매니페스트 위치 (원본 데이터 아님)
    }

    struct AuditAnchor {
        bytes32 merkleRoot;
        uint64  fromSeq;
        uint64  toSeq;
        uint64  timestamp;
        address auditor;
    }

    mapping(bytes32 => Record[]) private _history;   // dataKey => 단계별 이력
    mapping(bytes32 => string)   private _dataIdOf;  // dataKey => dataId 원문
    mapping(bytes32 => bytes32)  private _keyOfHash; // contentHash => dataKey
    mapping(bytes32 => uint256)  private _indexOfHash;
    bytes32[] private _dataKeys;
    AuditAnchor[] private _anchors;
    uint256 public totalRecords;

    event RecordRegistered(
        bytes32 indexed dataKey,
        Stage   indexed stage,
        address indexed registrar,
        string  dataId,
        bytes32 contentHash,
        bytes32 parentHash,
        string  metaURI,
        uint64  timestamp
    );
    event AuditLogAnchored(
        uint256 indexed anchorId,
        address indexed auditor,
        bytes32 merkleRoot,
        uint64  fromSeq,
        uint64  toSeq,
        uint64  timestamp
    );

    error ZeroAddress();
    error EmptyDataId();
    error EmptyHash();
    error DuplicateHash(bytes32 contentHash);
    error InvalidStageOrder(Stage last, Stage next);
    error NotFound(bytes32 dataKey);
    error InvalidRange(uint64 fromSeq, uint64 toSeq);

    /// @param admin 관리자 주소. 초기 운영 편의를 위해 등록·감사 권한도 함께 부여한다.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
        _grantRole(AUDITOR_ROLE, admin);
    }

    function keyOf(string memory dataId) public pure returns (bytes32) {
        return keccak256(bytes(dataId));
    }

    /// @notice 가공 단계 이력을 등록한다. 직전 단계 해시가 parentHash로 자동 연결된다.
    function registerRecord(string calldata dataId, Stage stage, bytes32 contentHash, string calldata metaURI)
        external
        onlyRole(REGISTRAR_ROLE)
    {
        if (bytes(dataId).length == 0) revert EmptyDataId();
        if (contentHash == bytes32(0)) revert EmptyHash();
        if (_keyOfHash[contentHash] != bytes32(0)) revert DuplicateHash(contentHash);

        bytes32 key = keccak256(bytes(dataId));
        Record[] storage h = _history[key];
        bytes32 parent;
        if (h.length == 0) {
            _dataKeys.push(key);
            _dataIdOf[key] = dataId;
        } else {
            Record storage last = h[h.length - 1];
            if (stage < last.stage) revert InvalidStageOrder(last.stage, stage);
            parent = last.contentHash;
        }

        h.push(Record(contentHash, parent, stage, msg.sender, uint64(block.timestamp), uint64(block.number), metaURI));
        _keyOfHash[contentHash] = key;
        _indexOfHash[contentHash] = h.length - 1;
        unchecked { totalRecords++; }

        emit RecordRegistered(key, stage, msg.sender, dataId, contentHash, parent, metaURI, uint64(block.timestamp));
    }

    /// @notice 콘텐츠 해시로 진위를 검증한다.
    function verify(bytes32 contentHash)
        external
        view
        returns (bool found, string memory dataId, uint256 index, Record memory record)
    {
        bytes32 key = _keyOfHash[contentHash];
        if (key == bytes32(0)) return (false, "", 0, record);
        index = _indexOfHash[contentHash];
        return (true, _dataIdOf[key], index, _history[key][index]);
    }

    function getHistory(string calldata dataId) external view returns (Record[] memory) {
        return _history[keccak256(bytes(dataId))];
    }

    function latest(string calldata dataId) external view returns (Record memory) {
        bytes32 key = keccak256(bytes(dataId));
        Record[] storage h = _history[key];
        if (h.length == 0) revert NotFound(key);
        return h[h.length - 1];
    }

    function datasetCount() external view returns (uint256) {
        return _dataKeys.length;
    }

    function datasetAt(uint256 i) external view returns (string memory dataId, uint256 records) {
        bytes32 key = _dataKeys[i];
        return (_dataIdOf[key], _history[key].length);
    }

    /// @notice 오프체인 감사 로그 묶음의 머클 루트를 기록한다.
    function anchorAuditLog(bytes32 merkleRoot, uint64 fromSeq, uint64 toSeq)
        external
        onlyRole(AUDITOR_ROLE)
    {
        if (fromSeq == 0 || toSeq < fromSeq) revert InvalidRange(fromSeq, toSeq);
        _anchors.push(AuditAnchor(merkleRoot, fromSeq, toSeq, uint64(block.timestamp), msg.sender));
        emit AuditLogAnchored(_anchors.length - 1, msg.sender, merkleRoot, fromSeq, toSeq, uint64(block.timestamp));
    }

    function auditAnchor(uint256 id) external view returns (AuditAnchor memory) {
        return _anchors[id];
    }

    function auditAnchorCount() external view returns (uint256) {
        return _anchors.length;
    }
}
