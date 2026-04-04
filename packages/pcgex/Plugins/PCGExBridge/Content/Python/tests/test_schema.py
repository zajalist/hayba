import unittest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class _MockClass:
    def __init__(self, name):
        self._name = name

    def get_name(self):
        return self._name

    def get_property_names(self):
        return ["Density", "Seed"]


class _MockElement:
    def __init__(self):
        self.Density = 5.0
        self.Seed = 12345

    def get_class(self):
        return _MockClass("PCGExElement")

    def get_name(self):
        return "TestElement"


class _MockNode:
    def __init__(self, label="TestNode"):
        self._label = label
        self._position = type('obj', (object,), {'x': -400, 'y': 0})()
        self._element = _MockElement()

    def get_class(self):
        return _MockClass("PCGExPointsOnSurface")

    def get_name(self):
        return "PCGExPointsOnSurface"

    def get_node_label(self):
        return self._label

    def get_node_editor_position(self):
        return self._position

    def get_element(self):
        return self._element


class TestGraphSchema(unittest.TestCase):
    """Test that the graph schema builder produces valid structures."""

    def test_empty_graph_schema(self):
        """An empty graph should produce a valid minimal schema."""
        from pcgex_exporter import build_graph_schema
        result = build_graph_schema(
            source_path="/Game/Test/TestGraph",
            ue_version="5.6",
            pcgex_version="0.70",
            tags=["test"]
        )
        self.assertEqual(result["version"], "1.0.0")
        self.assertEqual(result["meta"]["sourceGraph"], "/Game/Test/TestGraph")
        self.assertEqual(result["meta"]["tags"], ["test"])
        self.assertEqual(result["nodes"], [])
        self.assertEqual(result["edges"], [])
        self.assertIn("metadata", result)

    def test_graph_schema_with_node(self):
        """A graph with one node should serialize correctly."""
        from pcgex_exporter import build_graph_schema, serialize_node
        mock_node = _MockNode("Surface Points")
        node_data = serialize_node(mock_node, 1)
        schema = build_graph_schema(
            source_path="/Game/Test/TestGraph",
            ue_version="5.6",
            pcgex_version="0.70",
            tags=["test"]
        )
        schema["nodes"].append(node_data)
        self.assertEqual(len(schema["nodes"]), 1)
        self.assertEqual(schema["nodes"][0]["id"], "node_001")
        self.assertEqual(schema["nodes"][0]["class"], "PCGExPointsOnSurface")
        self.assertEqual(schema["nodes"][0]["label"], "Surface Points")
        self.assertEqual(schema["nodes"][0]["position"], {"x": -400, "y": 0})
        self.assertIn("Density", schema["nodes"][0]["properties"])

    def test_graph_schema_with_edge(self):
        """An edge should connect two nodes by ID and pin name."""
        from pcgex_exporter import build_graph_schema, serialize_edge
        schema = build_graph_schema(
            source_path="/Game/Test/TestGraph",
            ue_version="5.6",
            pcgex_version="0.70",
            tags=["test"]
        )
        edge = serialize_edge("node_001", "Out", "node_002", "In")
        schema["edges"].append(edge)
        self.assertEqual(len(schema["edges"]), 1)
        self.assertEqual(schema["edges"][0]["fromNode"], "node_001")
        self.assertEqual(schema["edges"][0]["fromPin"], "Out")
        self.assertEqual(schema["edges"][0]["toNode"], "node_002")
        self.assertEqual(schema["edges"][0]["toPin"], "In")

    def test_serialize_node_with_null_position(self):
        """A node with null editor position should default to (0, 0)."""
        from pcgex_exporter import serialize_node

        class MockNullPositionNode:
            def get_class(self):
                return _MockClass("PCGExTest")

            def get_node_label(self):
                return "Test"

            def get_node_editor_position(self):
                return None

            def get_element(self):
                return None

        node_data = serialize_node(MockNullPositionNode(), 0)
        self.assertEqual(node_data["position"], {"x": 0, "y": 0})

    def test_extract_tags_excludes_default_parts(self):
        """Tags should exclude Game, Engine, and PCGExExampleProject by default."""
        from pcgex_exporter import _extract_tags_from_path
        tags = _extract_tags_from_path("/Game/PCGExExampleProject/MyGraphs/Test")
        self.assertNotIn("game", tags)
        self.assertNotIn("pcgexexampleproject", tags)
        self.assertIn("mygraphs", tags)
        self.assertIn("test", tags)

    def test_extract_tags_custom_exclusions(self):
        """Tags should respect custom exclude_parts parameter."""
        from pcgex_exporter import _extract_tags_from_path
        tags = _extract_tags_from_path(
            "/Game/CustomProject/MyGraphs",
            exclude_parts=('Game', 'CustomProject')
        )
        self.assertNotIn("game", tags)
        self.assertNotIn("customproject", tags)
        self.assertIn("mygraphs", tags)

    def test_export_all_graphs_raises_without_ue5(self):
        """export_all_graphs should raise RuntimeError when called outside UE5."""
        import pcgex_exporter
        original_unreal = pcgex_exporter.unreal
        pcgex_exporter.unreal = None
        try:
            with self.assertRaises(RuntimeError) as ctx:
                pcgex_exporter.export_all_graphs("/Game/Test", "/tmp/out")
            self.assertIn("Must run inside UE5", str(ctx.exception))
        finally:
            pcgex_exporter.unreal = original_unreal


if __name__ == "__main__":
    unittest.main()
