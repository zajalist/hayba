import unittest
import sys
import os
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestIngestionValidator(unittest.TestCase):
    """Test JSON graph validation before ingestion."""

    def test_valid_graph_passes(self):
        """A properly structured graph should validate."""
        from mcp_ue_bridge import validate_graph
        graph = {
            "version": "1.0.0",
            "meta": {
                "sourceGraph": "/Game/Test",
                "ueVersion": "5.6",
                "pcgExVersion": "0.70",
                "exportedAt": "2026-04-03",
                "tags": []
            },
            "nodes": [],
            "edges": [],
            "metadata": {
                "inputSettings": {},
                "outputSettings": {},
                "graphSettings": {}
            }
        }
        valid, error_msg = validate_graph(graph)
        self.assertTrue(valid)
        self.assertIsNone(error_msg)

    def test_missing_version_fails(self):
        """Graph without version should fail validation."""
        from mcp_ue_bridge import validate_graph
        graph = {"nodes": [], "edges": []}
        valid, error_msg = validate_graph(graph)
        self.assertFalse(valid)
        self.assertIn("version", error_msg)

    def test_missing_nodes_fails(self):
        """Graph without nodes array should fail validation."""
        from mcp_ue_bridge import validate_graph
        graph = {"version": "1.0.0", "edges": []}
        valid, error_msg = validate_graph(graph)
        self.assertFalse(valid)
        self.assertIn("nodes", error_msg)

    def test_missing_edges_fails(self):
        """Graph without edges array should fail validation."""
        from mcp_ue_bridge import validate_graph
        graph = {"version": "1.0.0", "nodes": []}
        valid, error_msg = validate_graph(graph)
        self.assertFalse(valid)
        self.assertIn("edges", error_msg)

    def test_invalid_node_structure(self):
        """Node without required fields should fail."""
        from mcp_ue_bridge import validate_graph
        graph = {
            "version": "1.0.0",
            "meta": {"sourceGraph": "/Game/Test", "ueVersion": "5.6", "pcgExVersion": "0.70", "exportedAt": "2026-04-03", "tags": []},
            "nodes": [{"id": "n1"}],
            "edges": [],
            "metadata": {"inputSettings": {}, "outputSettings": {}, "graphSettings": {}}
        }
        valid, error_msg = validate_graph(graph)
        self.assertFalse(valid)
        self.assertIn("class", error_msg)

    def test_valid_node_with_minimal_fields(self):
        """Node with all required fields should pass."""
        from mcp_ue_bridge import validate_graph
        graph = {
            "version": "1.0.0",
            "meta": {"sourceGraph": "/Game/Test", "ueVersion": "5.6", "pcgExVersion": "0.70", "exportedAt": "2026-04-03", "tags": []},
            "nodes": [
                {
                    "id": "n1",
                    "class": "PCGExPointsOnSurface",
                    "label": "Test Node",
                    "position": {"x": 0, "y": 0},
                    "properties": {},
                    "customData": {}
                }
            ],
            "edges": [],
            "metadata": {"inputSettings": {}, "outputSettings": {}, "graphSettings": {}}
        }
        valid, error_msg = validate_graph(graph)
        self.assertTrue(valid)


class TestGraphReconstruction(unittest.TestCase):
    """Test graph reconstruction logic (pure Python parts)."""

    def test_build_node_id_map(self):
        """Node ID map should map JSON IDs to serializable references."""
        from mcp_ue_bridge import build_node_id_map
        nodes = [
            {"id": "node_001", "class": "PCGExPointsOnSurface", "label": "A", "position": {"x": 0, "y": 0}, "properties": {}, "customData": {}},
            {"id": "node_002", "class": "PCGExCluster", "label": "B", "position": {"x": 200, "y": 0}, "properties": {}, "customData": {}}
        ]
        id_map = build_node_id_map(nodes)
        self.assertEqual(id_map["node_001"]["class"], "PCGExPointsOnSurface")
        self.assertEqual(id_map["node_002"]["class"], "PCGExCluster")

    def test_resolve_edge_targets(self):
        """Edge resolution should validate both nodes exist."""
        from mcp_ue_bridge import resolve_edge_targets
        id_map = {
            "node_001": {"class": "PCGExPointsOnSurface"},
            "node_002": {"class": "PCGExCluster"}
        }
        edge = {"fromNode": "node_001", "fromPin": "Out", "toNode": "node_002", "toPin": "In"}
        valid, error = resolve_edge_targets(edge, id_map)
        self.assertTrue(valid)

    def test_resolve_edge_missing_target(self):
        """Edge with non-existent target should fail."""
        from mcp_ue_bridge import resolve_edge_targets
        id_map = {"node_001": {"class": "PCGExPointsOnSurface"}}
        edge = {"fromNode": "node_001", "fromPin": "Out", "toNode": "node_999", "toPin": "In"}
        valid, error = resolve_edge_targets(edge, id_map)
        self.assertFalse(valid)
        self.assertIn("node_999", error)


if __name__ == "__main__":
    unittest.main()
