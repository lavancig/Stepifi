#!/usr/bin/env python3

import sys
import os
import json
import zipfile
import tempfile
import shutil
import xml.etree.ElementTree as ET

# Save original stdout for final JSON output
ORIGINAL_STDOUT_FD = os.dup(1)

# Redirect stdout and stderr to /dev/null BEFORE importing FreeCAD
devnull_fd = os.open('/dev/null', os.O_WRONLY)
os.dup2(devnull_fd, 1)
os.dup2(devnull_fd, 2)

def debug_print(msg):
    """Print debug to original stderr (fd 2) - bypasses all redirection"""
    try:
        os.write(ORIGINAL_STDOUT_FD, f"[DEBUG] {msg}\n".encode())
    except:
        pass

debug_print("SCRIPT STARTING - ALL OUTPUT SUPPRESSED")

# Import FreeCAD with all output muted
debug_print("Importing FreeCAD modules...")
try:
    import FreeCAD
    import Part
    import Mesh
    import MeshPart
    import Import
    debug_print("FreeCAD modules imported successfully")
except Exception as e:
    os.dup2(ORIGINAL_STDOUT_FD, 1)
    print(json.dumps({
        "success": False,
        "error": f"FreeCAD import failed: {str(e)}",
        "stage": "import"
    }))
    sys.exit(0)


def clean_exit(result):
    """Restore stdout, print JSON, hard exit"""
    debug_print("Restoring stdout for JSON output")
    os.dup2(ORIGINAL_STDOUT_FD, 1)
    sys.stdout = os.fdopen(ORIGINAL_STDOUT_FD, 'w')
    print(json.dumps(result, indent=2))
    sys.stdout.flush()
    os._exit(0)


def get_mesh_info(mesh, skip_expensive=False):
    debug_print(f"Getting mesh info (skip_expensive={skip_expensive})")
    info = {
        "points": mesh.CountPoints,
        "facets": mesh.CountFacets,
        "edges": mesh.CountEdges,
    }

    info["is_solid"] = mesh.isSolid()
    info["volume"] = mesh.Volume if info["is_solid"] else None
    info["area"] = mesh.Area

    if not skip_expensive:
        debug_print("Checking non-manifolds...")
        info["has_non_manifolds"] = mesh.hasNonManifolds()
        debug_print("Checking self-intersections...")
        info["has_self_intersections"] = mesh.hasSelfIntersections()
    else:
        debug_print("Skipping expensive checks (large mesh)")

    return info


def repair_mesh(mesh, skip_expensive=False):
    debug_print("Starting mesh repair")
    repairs = []

    before_pts = mesh.CountPoints
    mesh.removeDuplicatedPoints()
    if mesh.CountPoints < before_pts:
        repairs.append(f"Removed {before_pts - mesh.CountPoints} duplicate points")

    before_f = mesh.CountFacets
    mesh.removeDuplicatedFacets()
    if mesh.CountFacets < before_f:
        repairs.append(f"Removed {before_f - mesh.CountFacets} duplicate facets")

    if not skip_expensive:
        debug_print("Checking self-intersections for repair...")
        if mesh.hasSelfIntersections():
            debug_print("Fixing self-intersections...")
            mesh.fixSelfIntersections()
            if not mesh.hasSelfIntersections():
                repairs.append("Fixed self-intersections")
    else:
        debug_print("Skipping self-intersection check (large mesh)")

    debug_print("Fixing degenerations...")
    try:
        mesh.fixDegenerations(0.0)
        repairs.append("Fixed degenerations")
    except:
        try:
            mesh.fixDegenerations()
            repairs.append("Fixed degenerations")
        except:
            pass

    if not skip_expensive:
        debug_print("Removing non-manifolds...")
        if mesh.hasNonManifolds():
            try:
                mesh.removeNonManifolds()
                if not mesh.hasNonManifolds():
                    repairs.append("Removed non-manifolds")
            except:
                pass
    else:
        debug_print("Skipping non-manifolds check (large mesh)")

    debug_print("Filling holes...")
    try:
        mesh.fillupHoles(1000)
        repairs.append("Filled holes")
    except:
        try:
            mesh.fillupHoles()
            repairs.append("Filled holes")
        except:
            pass

    debug_print("Harmonizing normals...")
    mesh.harmonizeNormals()
    repairs.append("Harmonized normals")

    debug_print(f"Mesh repair complete: {len(repairs)} operations")
    return mesh, repairs


def merge_planar_faces(shape, tolerance=0.01):
    debug_print("Attempting to merge planar faces...")
    try:
        # Refine first - this often helps removeSplitter work better
        debug_print("Refining shape...")
        refined = shape.refine()
        debug_print("Refinement complete, applying removeSplitter...")
        merged = refined.removeSplitter(tolerance)
        debug_print("Merge successful")
        return merged, True
    except:
        try:
            # Try without refinement
            debug_print("Refinement failed, trying removeSplitter directly...")
            merged = shape.removeSplitter(tolerance)
            debug_print("Merge without refinement successful")
            return merged, True
        except:
            try:
                # Try without tolerance
                debug_print("Trying removeSplitter without tolerance...")
                merged = shape.removeSplitter()
                debug_print("Merge without tolerance successful")
                return merged, True
            except:
                debug_print("Merge failed, using original shape")
                return shape, False


def load_stl_file(input_path):
    """Load STL file and return mesh"""
    debug_print("Reading STL file...")
    mesh = Mesh.Mesh()
    mesh.read(input_path)
    debug_print("STL file read complete")
    return mesh


def parse_3mf_model_xml(model_path, temp_dir=None):
    """Parse 3dmodel.model XML and extract mesh data with components and build
    
    Args:
        model_path: Path to the main 3dmodel.model file
        temp_dir: Temporary directory containing extracted 3MF contents (for external objects)
    """
    debug_print(f"Parsing 3MF model XML: {model_path}")
    
    try:
        tree = ET.parse(model_path)
        root = tree.getroot()
        
        # Define namespace (3MF uses a namespace)
        ns = {'ns': 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'}
        
        # First pass: collect all objects with mesh data indexed by ID
        objects_dict = {}
        
        for obj in root.findall('.//ns:object', ns):
            obj_id = obj.get('id')
            obj_type = obj.get('type')
            debug_print(f"Found object id={obj_id} type={obj_type}")
            
            # Check if it's a component (references another object)
            components = obj.find('ns:components', ns)
            if components is not None:
                component = components.find('ns:component', ns)
                if component is not None:
                    ref_id = component.get('objectid')
                    debug_print(f"Object {obj_id} is a component referencing object {ref_id}")
                    objects_dict[obj_id] = {'type': 'component', 'ref': ref_id}
                    continue
            
            # Look for mesh data
            mesh_elem = obj.find('ns:mesh', ns)
            if mesh_elem is None:
                debug_print(f"Object {obj_id} has no mesh element")
                continue
            
            # Extract vertices
            vertices = []
            vertices_elem = mesh_elem.find('ns:vertices', ns)
            if vertices_elem is not None:
                for vertex in vertices_elem.findall('ns:vertex', ns):
                    x = float(vertex.get('x', 0))
                    y = float(vertex.get('y', 0))
                    z = float(vertex.get('z', 0))
                    vertices.append((x, y, z))
            
            # Extract triangles
            triangles = []
            triangles_elem = mesh_elem.find('ns:triangles', ns)
            if triangles_elem is not None:
                for triangle in triangles_elem.findall('ns:triangle', ns):
                    v1 = int(triangle.get('v1', 0))
                    v2 = int(triangle.get('v2', 0))
                    v3 = int(triangle.get('v3', 0))
                    triangles.append((v1, v2, v3))
            
            debug_print(f"Object {obj_id}: {len(vertices)} vertices, {len(triangles)} triangles")
            
            if len(vertices) > 0 and len(triangles) > 0:
                objects_dict[obj_id] = {
                    'type': 'mesh',
                    'vertices': vertices,
                    'triangles': triangles
                }
        
        # Load external object files (BambuStudio/modern slicers)
        if temp_dir:
            objects_dir = os.path.join(temp_dir, '3D', 'Objects')
            if os.path.exists(objects_dir):
                debug_print(f"Checking for external object files in: {objects_dir}")
                for obj_file in os.listdir(objects_dir):
                    if obj_file.endswith('.model'):
                        obj_path = os.path.join(objects_dir, obj_file)
                        debug_print(f"Parsing external object file: {obj_file}")
                        
                        try:
                            obj_tree = ET.parse(obj_path)
                            obj_root = obj_tree.getroot()
                            
                            # Parse objects in this external file
                            for obj in obj_root.findall('.//ns:object', ns):
                                obj_id = obj.get('id')
                                obj_type = obj.get('type')
                                debug_print(f"  External object id={obj_id} type={obj_type}")
                                
                                mesh_elem = obj.find('ns:mesh', ns)
                                if mesh_elem is not None:
                                    vertices = []
                                    vertices_elem = mesh_elem.find('ns:vertices', ns)
                                    if vertices_elem is not None:
                                        for vertex in vertices_elem.findall('ns:vertex', ns):
                                            x = float(vertex.get('x', 0))
                                            y = float(vertex.get('y', 0))
                                            z = float(vertex.get('z', 0))
                                            vertices.append((x, y, z))
                                    
                                    triangles = []
                                    triangles_elem = mesh_elem.find('ns:triangles', ns)
                                    if triangles_elem is not None:
                                        for triangle in triangles_elem.findall('ns:triangle', ns):
                                            v1 = int(triangle.get('v1', 0))
                                            v2 = int(triangle.get('v2', 0))
                                            v3 = int(triangle.get('v3', 0))
                                            triangles.append((v1, v2, v3))
                                    
                                    if len(vertices) > 0 and len(triangles) > 0:
                                        objects_dict[obj_id] = {
                                            'type': 'mesh',
                                            'vertices': vertices,
                                            'triangles': triangles
                                        }
                                        debug_print(f"  Loaded external object {obj_id}: {len(vertices)} vertices, {len(triangles)} triangles")
                        except Exception as e:
                            debug_print(f"  Failed to parse {obj_file}: {e}")
        
        # Second pass: process build section to get instances
        meshes_data = []
        build = root.find('.//ns:build', ns)
        
        if build is not None:
            debug_print("Processing build section...")
            for item in build.findall('ns:item', ns):
                obj_id = item.get('objectid')
                debug_print(f"Build item references object {obj_id}")
                
                # Resolve object (handle components)
                resolved_obj = objects_dict.get(obj_id)
                if resolved_obj is None:
                    debug_print(f"Warning: object {obj_id} not found")
                    continue
                
                # If it's a component, resolve the reference
                if resolved_obj.get('type') == 'component':
                    ref_id = resolved_obj['ref']
                    debug_print(f"Resolving component: {obj_id} -> {ref_id}")
                    resolved_obj = objects_dict.get(ref_id)
                    if resolved_obj is None:
                        debug_print(f"Warning: referenced object {ref_id} not found")
                        continue
                
                # Add mesh data
                if resolved_obj.get('type') == 'mesh':
                    meshes_data.append({
                        'vertices': resolved_obj['vertices'],
                        'triangles': resolved_obj['triangles']
                    })
                    debug_print(f"Added mesh from object {obj_id}")
        
        # Fallback: if no build section, just use all mesh objects
        if len(meshes_data) == 0:
            debug_print("No build section found, using all mesh objects")
            for obj_id, obj_data in objects_dict.items():
                if obj_data.get('type') == 'mesh':
                    meshes_data.append({
                        'vertices': obj_data['vertices'],
                        'triangles': obj_data['triangles']
                    })
        
        debug_print(f"Total meshes to create: {len(meshes_data)}")
        return meshes_data
        
    except Exception as e:
        debug_print(f"XML parsing failed: {e}")
        import traceback
        debug_print(traceback.format_exc())
        return []


def create_mesh_from_data(vertices, triangles):
    """Create FreeCAD Mesh from vertex and triangle data"""
    debug_print(f"Creating mesh from {len(vertices)} vertices and {len(triangles)} triangles")
    
    try:
        # Create mesh object
        mesh = Mesh.Mesh()
        
        # Build facets (triangles) from the data
        facets = []
        for tri in triangles:
            v1_idx, v2_idx, v3_idx = tri
            
            # Get the actual vertex coordinates
            v1 = vertices[v1_idx]
            v2 = vertices[v2_idx]
            v3 = vertices[v3_idx]
            
            # Create facet (triangle) - format: ((v1x,v1y,v1z), (v2x,v2y,v2z), (v3x,v3y,v3z))
            facets.append((v1, v2, v3))
        
        # Add all facets to mesh
        mesh.addFacets(facets)
        
        debug_print(f"Mesh created successfully with {mesh.CountFacets} facets")
        return mesh
        
    except Exception as e:
        debug_print(f"Mesh creation failed: {e}")
        raise Exception(f"Failed to create mesh from data: {str(e)}")


def load_3mf_file(input_path):
    """Load 3MF file and return list of meshes (one per object)"""
    debug_print("Processing 3MF file...")
    
    temp_dir = tempfile.mkdtemp(prefix='3mf_extract_')
    debug_print(f"Created temp directory: {temp_dir}")
    
    try:
        # Extract 3MF (it's a ZIP file)
        debug_print(f"Extracting 3MF archive: {input_path}")
        with zipfile.ZipFile(input_path, 'r') as zip_ref:
            debug_print(f"3MF contents: {zip_ref.namelist()}")
            zip_ref.extractall(temp_dir)
        
        meshes = []
        
        # Look for embedded STL files first
        stl_files = []
        for root, dirs, files in os.walk(temp_dir):
            for file in files:
                if file.lower().endswith('.stl'):
                    stl_path = os.path.join(root, file)
                    stl_files.append(stl_path)
                    debug_print(f"Found STL file: {stl_path}")
        
        # Load STL files if found
        if stl_files:
            debug_print(f"Loading {len(stl_files)} STL file(s)")
            for stl_path in stl_files:
                mesh = Mesh.Mesh()
                mesh.read(stl_path)
                debug_print(f"Loaded STL with {mesh.CountFacets} facets")
                meshes.append(mesh)
        
        # If no STL files, parse the 3dmodel.model XML
        if len(meshes) == 0:
            model_file = os.path.join(temp_dir, '3D', '3dmodel.model')
            if os.path.exists(model_file):
                debug_print(f"No STL files found, parsing XML: {model_file}")
                
                # Pass temp_dir so parser can find external object files
                meshes_data = parse_3mf_model_xml(model_file, temp_dir)
                
                if len(meshes_data) == 0:
                    raise Exception("No mesh data found in 3MF XML")
                
                debug_print(f"Found {len(meshes_data)} mesh object(s) in XML")
                
                # Create FreeCAD meshes from the data
                for i, mesh_data in enumerate(meshes_data):
                    debug_print(f"Creating mesh {i+1} of {len(meshes_data)}")
                    mesh = create_mesh_from_data(
                        mesh_data['vertices'],
                        mesh_data['triangles']
                    )
                    meshes.append(mesh)
            else:
                raise Exception("No 3dmodel.model file found in 3MF")
        
        if len(meshes) == 0:
            raise Exception("No valid mesh data found in 3MF file")
        
        debug_print(f"3MF processing complete - returning {len(meshes)} separate mesh(es)")
        return meshes  # Return list instead of combined mesh
        
    finally:
        # Clean up
        try:
            shutil.rmtree(temp_dir)
            debug_print(f"Cleaned up temp directory: {temp_dir}")
        except:
            debug_print(f"Failed to clean up temp directory: {temp_dir}")


def convert(input_path, output_path, tolerance=0.01, repair=True, info_only=False, input_format='stl', skip_face_merge=False, output_format='step'):
    debug_print("="*60)
    debug_print(f"CONVERSION STARTED")
    debug_print(f"Input: {input_path}")
    debug_print(f"Output: {output_path}")
    debug_print(f"Input Format: {input_format}")
    debug_print(f"Output Format: {output_format}")
    debug_print(f"Tolerance: {tolerance}")
    debug_print(f"Repair: {repair}")
    debug_print(f"Skip Face Merge: {skip_face_merge}")
    debug_print("="*60)

    result = {
        "success": False,
        "input": input_path,
        "output": output_path,
        "input_format": input_format,
        "output_format": output_format,
        "tolerance": tolerance
    }

    if not os.path.exists(input_path):
        debug_print("ERROR: Input file not found")
        result["error"] = "Input file not found"
        clean_exit(result)

    # Load mesh based on file format
    try:
        if input_format == '3mf':
            meshes = load_3mf_file(input_path)  # Returns list of meshes
        else:
            meshes = [load_stl_file(input_path)]  # Wrap in list for uniform handling
    except Exception as e:
        debug_print(f"ERROR: Failed to load {input_format.upper()} file: {e}")
        result["error"] = f"Failed to load {input_format.upper()} file: {str(e)}"
        clean_exit(result)

    if len(meshes) == 0 or (len(meshes) == 1 and meshes[0].CountFacets == 0):
        debug_print("ERROR: Mesh has no facets")
        result["error"] = f"{input_format.upper()} contains no facets"
        clean_exit(result)

    total_facets = sum(m.CountFacets for m in meshes)
    debug_print(f"Processing {len(meshes)} mesh object(s) with {total_facets} total facets")

    skip_expensive = total_facets > 50000
    if skip_expensive:
        debug_print(f"Large mesh ({total_facets} facets), skipping expensive checks")

    # Process each mesh
    processed_meshes = []
    all_repairs = []
    
    for i, mesh in enumerate(meshes):
        debug_print(f"Processing mesh {i+1} of {len(meshes)} ({mesh.CountFacets} facets)")
        
        result[f"mesh_info_before_{i}"] = get_mesh_info(mesh, skip_expensive=skip_expensive)

        if repair:
            debug_print(f"Repairing mesh {i+1}...")
            mesh, repairs = repair_mesh(mesh, skip_expensive=skip_expensive)
            all_repairs.extend([f"Mesh {i+1}: {r}" for r in repairs])
            result[f"mesh_info_after_{i}"] = get_mesh_info(mesh, skip_expensive=skip_expensive)
        
        processed_meshes.append(mesh)
    
    result["repairs"] = all_repairs
    
    # Set mesh_info_before/after for backward compatibility (use first mesh)
    if "mesh_info_before_0" in result:
        result["mesh_info_before"] = result["mesh_info_before_0"]
    if "mesh_info_after_0" in result:
        result["mesh_info_after"] = result["mesh_info_after_0"]

    if info_only:
        debug_print("Info-only mode, exiting")
        result["success"] = True
        clean_exit(result)

    # Export based on output format
    if output_format.lower() == 'stl':
        # For STL output, combine all meshes and export directly
        debug_print("Exporting to STL format...")
        
        if len(processed_meshes) == 1:
            combined_mesh = processed_meshes[0]
        else:
            debug_print(f"Combining {len(processed_meshes)} meshes...")
            combined_mesh = Mesh.Mesh()
            for mesh in processed_meshes:
                combined_mesh.addMesh(mesh)
            debug_print("Meshes combined successfully")
        
        debug_print(f"Writing STL to: {output_path}")
        combined_mesh.write(output_path)
        
        if not os.path.exists(output_path):
            debug_print("ERROR: STL file was not created")
            result["error"] = "STL export failed"
            clean_exit(result)
        
        output_size = os.path.getsize(output_path)
        debug_print(f"SUCCESS! STL file created: {output_size} bytes")
        
        result["success"] = True
        result["output_size"] = output_size
        result["is_solid"] = False  # STL is mesh format
        
    else:
        # STEP output - create solids using FreeCAD
        debug_print("Creating FreeCAD document for STEP export...")
        doc = FreeCAD.newDocument("Job")

        # Convert each mesh to a solid
        solids = []
        shapes = []
        
        for i, mesh in enumerate(processed_meshes):
            debug_print(f"Converting mesh {i+1} to shape...")
            debug_print(f"Processing {mesh.CountFacets} facets (THIS MAY TAKE SEVERAL MINUTES)...")
            
            # For mesh-to-shape conversion, use a more relaxed tolerance to create fewer faces
            # Multiply user tolerance by 5 to reduce over-tessellation
            shape_tolerance = tolerance * 5.0
            debug_print(f"Using shape conversion tolerance: {shape_tolerance}")
            
            shape = Part.Shape()
            shape.makeShapeFromMesh(mesh.Topology, shape_tolerance)
            debug_print(f"Shape {i+1} conversion complete!")

            debug_print(f"Attempting to create solid {i+1}...")
            try:
                solid = Part.makeSolid(shape)
                
                # Merge planar faces on this solid NOW (before compound)
                if not skip_face_merge and mesh.CountFacets <= 100000:
                    debug_print(f"Merging planar faces for solid {i+1}...")
                    # Use more aggressive tolerance for merging - multiply by 10
                    merge_tolerance = tolerance * 10.0
                    debug_print(f"Using merge tolerance: {merge_tolerance}")
                    solid, merged = merge_planar_faces(solid, merge_tolerance)
                    if merged:
                        debug_print(f"Solid {i+1} faces merged successfully")
                elif skip_face_merge:
                    debug_print(f"Skipping face merge for solid {i+1} (skip_face_merge=True)")
                
                solids.append(solid)
                debug_print(f"Successfully created solid {i+1}")
            except Exception as e:
                debug_print(f"Could not create solid {i+1}: {e}, using shell instead")
                shapes.append(shape)

        # Create final object
        if len(solids) > 0 and len(shapes) == 0:
            # All meshes converted to solids
            result["is_solid"] = True
            if len(solids) == 1:
                final = solids[0]
                debug_print("Using single solid")
            else:
                # Create compound of all solids
                debug_print(f"Creating compound of {len(solids)} solids...")
                final = Part.makeCompound(solids)
                debug_print("Compound created")
        elif len(shapes) > 0 and len(solids) == 0:
            # No solids, using shells
            result["is_solid"] = False
            if len(shapes) == 1:
                final = shapes[0]
                debug_print("Using single shell")
            else:
                debug_print(f"Creating compound of {len(shapes)} shells...")
                final = Part.makeCompound(shapes)
        else:
            # Mixed solids and shells
            result["is_solid"] = False
            all_objects = solids + shapes
            if len(all_objects) == 1:
                final = all_objects[0]
            else:
                debug_print(f"Creating compound of {len(all_objects)} objects...")
                final = Part.makeCompound(all_objects)

        # For multi-object 3MF, faces were already merged per-solid
        # Only try compound-level merge for single objects
        if not skip_face_merge and len(processed_meshes) == 1 and total_facets <= 100000:
            merge_tolerance = tolerance * 10.0
            debug_print(f"Single object - merging with tolerance: {merge_tolerance}")
            final, merged_ok = merge_planar_faces(final, merge_tolerance)
            result["merged_planar_faces"] = merged_ok
        elif skip_face_merge:
            debug_print("Skipping final face merge (skip_face_merge=True)")
            result["merged_planar_faces"] = False
        elif len(processed_meshes) > 1:
            debug_print("Multi-object file - faces already merged per-solid")
            result["merged_planar_faces"] = True
            result["merged_per_solid"] = True
        else:
            debug_print(f"Skipping removeSplitter - mesh too large ({total_facets} facets)")
            result["merged_planar_faces"] = False
            result["skipped_merge_reason"] = f"Mesh too large ({total_facets} facets)"

        debug_print("Adding object to document...")
        obj = doc.addObject("Part::Feature", "Mesh")
        obj.Shape = final

        debug_print(f"Exporting to STEP: {output_path}")
        Import.export([obj], output_path)
        debug_print("Export command executed")

        if not os.path.exists(output_path):
            debug_print("ERROR: STEP file was not created")
            result["error"] = "STEP export failed"
            clean_exit(result)

        output_size = os.path.getsize(output_path)
        debug_print(f"SUCCESS! STEP file created: {output_size} bytes")

        result["success"] = True
        result["output_size"] = output_size

        try:
            FreeCAD.closeDocument(doc.Name)
        except:
            pass

    debug_print("="*60)
    debug_print("CONVERSION COMPLETE")
    debug_print("="*60)

    clean_exit(result)


def main():
    debug_print("main() function called")
    debug_print(f"Arguments: {sys.argv}")

    if len(sys.argv) < 4:
        os.dup2(ORIGINAL_STDOUT_FD, 1)
        print("Usage: freecadcmd script.py input_file output_file [tolerance] [repair|no-repair] [input_format] [skip-merge|merge] [output_format]")
        sys.exit(1)

    input_file = sys.argv[2]
    output_file = sys.argv[3]
    tolerance = float(sys.argv[4]) if len(sys.argv) > 4 else 0.01
    repair = sys.argv[5].lower() != 'no-repair' if len(sys.argv) > 5 else True
    input_format = sys.argv[6] if len(sys.argv) > 6 else 'stl'
    skip_face_merge = sys.argv[7].lower() == 'skip-merge' if len(sys.argv) > 7 else False
    output_format = sys.argv[8] if len(sys.argv) > 8 else 'step'
    info_only = False

    debug_print(f"Parsed: input={input_file}, output={output_file}, tol={tolerance}, repair={repair}, input_format={input_format}, skip_face_merge={skip_face_merge}, output_format={output_format}")

    convert(input_file, output_file, tolerance, repair, info_only, input_format, skip_face_merge, output_format)


debug_print("Calling main() unconditionally (FreeCAD compatibility)")
main()
