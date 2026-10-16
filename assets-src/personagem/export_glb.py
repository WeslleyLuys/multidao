import bpy, sys
out = sys.argv[sys.argv.index('--') + 1]
ob = bpy.data.objects['Cube']
arm = bpy.data.objects['Armature']
# Remove modificadores de armature vazios (sem alvo).
for m in list(ob.modifiers):
    if m.type == 'ARMATURE' and m.object is None:
        ob.modifiers.remove(m)
# Remove grupos de vértices órfãos ("Bone", "Bone.001"...).
for g in list(ob.vertex_groups):
    if g.name.startswith('Bone'):
        ob.vertex_groups.remove(g)
for o in list(bpy.data.objects):
    if o.type in ('CAMERA', 'LIGHT'):
        bpy.data.objects.remove(o)
ob.name = 'Corpo'
arm.name = 'Esqueleto'
bpy.ops.export_scene.gltf(
    filepath=out, export_format='GLB', use_selection=False,
    export_apply=True, export_skins=True, export_animations=False, export_morph=False,
    export_yup=True, export_texcoords=True, export_normals=True, export_materials='NONE',
)
print("EXPORT OK", out)
